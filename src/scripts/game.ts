// The actual game: loads a track, generates its route, and runs the
// canvas renderer + input loop around track.ts's already-tested
// hasCrashed. This is where onset detection (rhythm.ts), turn selection
// (rhythm.ts), route shape (route.ts), and the pure game rule (track.ts)
// all come together for the first time — everything upstream of this file
// is pure/tested; this file is the DOM/canvas/audio glue.
//
// The corridor (route.points) is the fixed, beat-derived shape. The
// player's line is drawn via track.ts's linePosition — the corridor's own
// position at each instant, offset sideways by however far off-center the
// player's clicks have drifted *this turn* (see track.ts for why that
// offset resets every turn, not just at the start of a run). hasCrashed
// checks every frame against that same offset.
//
// Deliberately NOT included yet: the end-of-run zoom-to-top-down tween
// (PLAN.md step 5) — that's the next step, after a human playtests this.

import { loadMonoSamples, detectOnsets, markTurns } from "./rhythm";
import { buildRouteShape, rotate, type RoutePoint } from "./route";
import { hasCrashed, linePosition } from "./track";

const MAX_ROUTE_SECONDS = 60;
const TRAIL_LENGTH = 240;
// Also the timing tolerance for a click, and the wrong-click-to-death lag —
// the same single number, since both are CORRIDOR_HALF_WIDTH / ROUTE_SPEED
// (route.ts): widening this widens the corridor, loosens how far off a
// click can land, and delays death, all at once, because the crash check
// (track.ts's hasCrashed) is purely spatial with no separate timing check.
// This coupling is deliberate, not a thing to split apart later — see
// PLAN.md's "Locked mechanic/UI invariants" section. 28/300 = 93ms here —
// widened again once the line itself gained real width (LINE_WIDTH below):
// a narrower corridor made the line's own rendered edge visually poke past
// the wall well before the centerline check actually crashed. Still under
// the ~100ms threshold past which click and death stop reading as
// simultaneous.
const CORRIDOR_HALF_WIDTH = 28;
// How long a decoration's flash lasts after the dot reaches it — the pulse
// that proves the route is actually tied to this track's rhythm, not just
// its turns (PLAN.md scope item 7).
const PULSE_DURATION_SECONDS = 0.25;
// Width of the player's own drawn line — clearly narrower than the corridor
// (CORRIDOR_HALF_WIDTH*2 = 56) so it never looks like it fills the
// corridor, but wide enough to read as an actual line with give, not a
// point (PLAN.md round 6).
const LINE_WIDTH = 14;

type TerminalState = "dead" | "finished";

type Vector = { x: number; y: number };

function headingBetween(a: Vector, b: Vector): Vector {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  return length > 0 ? { x: dx / length, y: dy / length } : { x: 0, y: -1 };
}

function addScaled(p: Vector, dir: Vector, amount: number): Vector {
  return { x: p.x + dir.x * amount, y: p.y + dir.y * amount };
}

/**
 * Arc a Path2D from `from` to `to` around `center` (both assumed to already
 * sit at exactly `radius` from `center`), sweeping whichever way is
 * shorter. For every interior route vertex this is a plain 90° turn, so
 * `delta` always comes out to exactly ±90° regardless of which way the
 * corridor actually turns there — verified by hand against the (0,-1)
 * heading case in PLAN.md's round-7 note before relying on it generally.
 */
function arcBetween(path: Path2D, center: Vector, from: Vector, to: Vector, radius: number): void {
  const startAngle = Math.atan2(from.y - center.y, from.x - center.x);
  const endAngle = Math.atan2(to.y - center.y, to.x - center.x);
  let delta = endAngle - startAngle;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  while (delta > Math.PI) delta -= Math.PI * 2;
  path.arc(center.x, center.y, radius, startAngle, startAngle + delta, delta < 0);
}

/**
 * The corridor as a filled offset polygon, not a stroked centerline — see
 * PLAN.md's round-7 note for why a stroke can't do this. Both boundaries
 * (the "right" one at +halfWidth along `rotate(heading, true)`, and the
 * "left" one at -halfWidth along the same axis — the exact axis
 * track.ts's hasCrashed measures against, so the drawn wall matches the
 * real hitbox on both sides, not just the outer one a round stroke join
 * used to cover) run past every vertex at exactly `halfWidth` from it
 * (that's what "offset by halfWidth" means), so each corner — inner and
 * outer alike — is filleted with a plain arc of that radius centered on
 * the vertex itself, connecting the two boundaries' natural offset feet.
 * No miter-intersection math anywhere, and no shape stamped on top of the
 * centerline: this *is* the wall's own outline. Computed once after the
 * route is built, not per frame — it's static for the whole run.
 */
function buildCorridorOutline(points: RoutePoint[], halfWidth: number): Path2D {
  const path = new Path2D();
  const n = points.length;
  if (n < 2) return path;
  const h = halfWidth;

  const headings: Vector[] = [];
  for (let i = 0; i < n - 1; i++) headings.push(headingBetween(points[i], points[i + 1]));

  // Right boundary (+halfWidth side), start -> end, filleting each interior vertex.
  const rightStart = addScaled(points[0], rotate(headings[0], true), h);
  path.moveTo(rightStart.x, rightStart.y);
  for (let i = 1; i < n - 1; i++) {
    const footIn = addScaled(points[i], rotate(headings[i - 1], true), h);
    const footOut = addScaled(points[i], rotate(headings[i], true), h);
    path.lineTo(footIn.x, footIn.y);
    arcBetween(path, points[i], footIn, footOut, h);
  }
  const rightEnd = addScaled(points[n - 1], rotate(headings[n - 2], true), h);
  path.lineTo(rightEnd.x, rightEnd.y);

  // End cap: a round join bulging forward, past the last vertex — the
  // same "shortest way" logic doesn't disambiguate a semicircle (both
  // directions are 180°), so this sweeps explicitly through the forward
  // direction (worked out by hand against a concrete heading, see
  // PLAN.md): anticlockwise=true from (heading+90°) to (heading-90°).
  const endAngle = Math.atan2(headings[n - 2].y, headings[n - 2].x);
  path.arc(points[n - 1].x, points[n - 1].y, h, endAngle + Math.PI / 2, endAngle - Math.PI / 2, true);

  // Left boundary (-halfWidth side), walked end -> start.
  for (let i = n - 2; i >= 1; i--) {
    const footOut = addScaled(points[i], rotate(headings[i], true), -h);
    const footIn = addScaled(points[i], rotate(headings[i - 1], true), -h);
    path.lineTo(footOut.x, footOut.y);
    arcBetween(path, points[i], footOut, footIn, h);
  }
  const leftStart = addScaled(points[0], rotate(headings[0], true), -h);
  path.lineTo(leftStart.x, leftStart.y);

  // Start cap: same construction, bulging backward instead of forward —
  // also anticlockwise=true (verified by hand; this isn't the mirror of
  // the end cap's parameters, both ends up needing anticlockwise=true
  // once you actually work out which side each sweep direction passes
  // through, see PLAN.md).
  const startAngle = Math.atan2(headings[0].y, headings[0].x);
  path.arc(points[0].x, points[0].y, h, startAngle - Math.PI / 2, startAngle + Math.PI / 2, true);

  path.closePath();
  return path;
}

export async function startGame(canvas: HTMLCanvasElement, trackUrl: string): Promise<void> {
  const { samples, sampleRate } = await loadMonoSamples(trackUrl);
  const trackDuration = samples.length / sampleRate;
  const onsets = detectOnsets(samples, sampleRate);
  const beats = markTurns(onsets);
  const route = buildRouteShape(beats, { maxDurationSeconds: Math.min(MAX_ROUTE_SECONDS, trackDuration) });
  const corridorOutline = buildCorridorOutline(route.points, CORRIDOR_HALF_WIDTH);

  const ctx = canvas.getContext("2d")!;
  const audio = new Audio(trackUrl);

  let startTimeMs = performance.now();
  let elapsed = 0;
  let clickTimes: number[] = [];
  let terminal: TerminalState | null = null;
  let trail: { x: number; y: number }[] = [];
  // Whether audio is confirmed actually playing — the browser can block the
  // initial autoplay attempt entirely, so gameplay never depends on this.
  let audioPlaying = false;

  function attemptAudioPlay() {
    audioPlaying = false;
    void audio
      .play()
      .then(() => {
        audioPlaying = true;
      })
      .catch(() => {});
  }

  function reset() {
    startTimeMs = performance.now();
    elapsed = 0;
    clickTimes = [];
    terminal = null;
    trail = [];
    audio.pause();
    audio.currentTime = 0;
    attemptAudioPlay();
  }

  attemptAudioPlay();

  function catchUpAudio() {
    // Only needed if the initial autoplay attempt was blocked — if audio is
    // already playing on its own clock, seeking it here would just cause an
    // audible skip for no reason.
    if (audioPlaying || terminal) return;
    audio.currentTime = elapsed;
    attemptAudioPlay();
  }

  function onInput() {
    if (terminal) {
      reset();
      return;
    }
    catchUpAudio();
    clickTimes.push(elapsed);
    checkState();
  }

  window.addEventListener("pointerdown", onInput);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      onInput();
    }
  });

  function checkState() {
    if (hasCrashed(route.turnTimes, clickTimes, elapsed, CORRIDOR_HALF_WIDTH)) {
      terminal = "dead";
      audio.pause();
      return;
    }
    if (elapsed >= route.duration) {
      terminal = "finished";
      audio.pause();
    }
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  function draw() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const clampedElapsed = Math.min(elapsed, route.duration);
    const dot = linePosition(route.turnTimes, clickTimes, clampedElapsed);

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 - dot.x, height / 2 - dot.y);

    // Corridor: the whole known route, drawn ahead and behind — seeing the
    // path coming is the reference game's own affordance, not a shortcut.
    // Filled offset polygon (buildCorridorOutline), not a stroked
    // centerline — its fillets, on both the inner and outer side of every
    // turn, are literal arcs of radius CORRIDOR_HALF_WIDTH centered on the
    // route's own vertex, so the drawn wall matches hasCrashed's actual
    // hitbox exactly everywhere, not just the outer side a round stroke
    // join used to cover (see PLAN.md's round-7 note).
    ctx.fillStyle = "#3a3f4b";
    ctx.fill(corridorOutline);

    // Beat-synced pulse: every decoration is a faint dot always visible
    // (same "seeing it coming" affordance as the corridor itself), and
    // brightens into an expanding ring right as the dot reaches its time —
    // turns aren't the only onsets the rhythm pass found, this is what
    // makes the quieter stretches between turns still visibly on-beat.
    for (const marker of route.decorations) {
      const dt = clampedElapsed - marker.time;
      ctx.fillStyle = "rgba(142, 207, 255, 0.35)";
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 2.5, 0, Math.PI * 2);
      ctx.fill();

      if (dt >= 0 && dt <= PULSE_DURATION_SECONDS) {
        const progress = dt / PULSE_DURATION_SECONDS;
        const alpha = 1 - progress;
        ctx.strokeStyle = `rgba(142, 207, 255, ${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, 4 + progress * 14, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // The player's line, drawn with actual width (not a chain of dots) —
    // gives the line some visual give at a turn instead of reading as a
    // bare point relocating.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < trail.length; i++) {
      const alpha = (i + 1) / trail.length;
      ctx.strokeStyle = `rgba(255, 214, 92, ${alpha * 0.8})`;
      ctx.lineWidth = LINE_WIDTH;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }

    // The dot itself.
    ctx.fillStyle = terminal === "dead" ? "#ff3b30" : "#ffd65c";
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Progress readout (PLAN.md step 6.2) — a thin bar + percentage fixed to
    // the top of the screen, in screen space (drawn after ctx.restore(), so
    // it doesn't pan/zoom with the world like the corridor does). Lets a
    // player tell how far through the run they are without it competing for
    // attention with the corridor itself.
    const progress = route.duration > 0 ? clampedElapsed / route.duration : 0;
    const barMargin = 24;
    const barWidth = width - barMargin * 2;
    const barHeight = 4;
    const barY = 20;
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.fillRect(barMargin, barY, barWidth, barHeight);
    ctx.fillStyle = "#ffd65c";
    ctx.fillRect(barMargin, barY, barWidth * progress, barHeight);
    const percentLabel = `${Math.round(progress * 100)}%`;
    ctx.font = "13px monospace";
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillText(percentLabel, barMargin + barWidth, barY + barHeight + 6);
    ctx.textAlign = "left";

    // Playback-time readout for pinpointing exactly where a bad death
    // happens — dev-only, stripped from the production build (see
    // main.ts's DEV gating for the same pattern).
    if (import.meta.env.DEV) {
      const label = `t=${elapsed.toFixed(2)}s  audio=${audio.currentTime.toFixed(2)}s`;
      ctx.font = "14px monospace";
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
      ctx.fillRect(8, 8, textWidth + 16, 24);
      ctx.fillStyle = "#0f0";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 16, 20);
    }

    requestAnimationFrame(loop);
  }

  function loop() {
    if (!terminal) {
      elapsed = (performance.now() - startTimeMs) / 1000;
      const clampedElapsed = Math.min(elapsed, route.duration);
      trail.push(linePosition(route.turnTimes, clickTimes, clampedElapsed));
      if (trail.length > TRAIL_LENGTH) trail.shift();
      checkState();
    }
    draw();
  }
  requestAnimationFrame(loop);
}
