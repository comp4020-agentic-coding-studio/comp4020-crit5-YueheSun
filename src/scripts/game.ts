// The actual game: loads a track, generates its route, and runs the
// canvas renderer + input loop around track.ts's already-tested
// hasCrashed. This is where onset detection (rhythm.ts), turn selection
// (rhythm.ts), route shape (route.ts), and the pure game rule (track.ts)
// all come together for the first time — everything upstream of this file
// is pure/tested; this file is the DOM/canvas/audio glue.
//
// The corridor (route.points) is the fixed, beat-derived shape. The
// player's line is drawn via track.ts's linePosition — the corridor's own
// position at each instant, plus however far off-center the player's clicks
// have drifted *this turn* (see track.ts for why that drift resets every
// turn, not just at the start of a run). hasCrashed checks every frame
// whether that same drawn point has actually strayed past a wall — real
// clamped distance to the corridor's own polyline, not an abstract axis.
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
// The camera's follow-smoothing time constant. track.ts's recenteredPosition
// (see its own comment) snaps the drawn dot exactly onto the corridor
// centerline at *every* corner, not just ones the player mistimes — round 6
// decided that's the right thing for the dot/hitbox to do. But the camera
// used to be bound 1:1 to that same point (`ctx.translate` below), so it
// snapped too, at every corner in the whole route — reported as violent
// shake while turning. Fix: the camera lerps toward the dot instead of
// equalling it, using a plain 2D exponential filter on the camera's own
// position only — the dot, trail, and hasCrashed all still use the exact,
// unsmoothed point (see `draw()`), so this can't touch fairness or
// reintroduce round 6's diagonal-axis bug (that blended two perpendicular
// lateral axes into the *judged* position itself; this only blends where the
// viewport is centered).
const CAMERA_SMOOTHING_SECONDS = 0.15;

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
 * Fillet one boundary line (`sign` = +1 for the "+lateral" offset, -1 for
 * "-lateral") at interior route vertex `V`, appending to `path` — which
 * must already be positioned at the point just before whichever of the
 * two feet comes first in path order (`reverse` = true when this boundary
 * is being walked end→start, as the left/-lateral loop does).
 *
 * Both sides just get a plain arc of radius `h` centered on `V` itself,
 * tangent to both straight offset lines at their natural feet
 * (`V + sign*h*lateral`). Round 7 tried to give the concave (inner) side
 * of a turn a *different*, more generous construction on the theory that
 * it should match track.ts's hasCrashed there — but at the time,
 * hasCrashed had no notion of distance-to-vertex at all (it was a signed
 * offset along the corridor's *current* heading, reset at each turn
 * instant), so there was no vertex-shaped hitbox for a wall render to
 * match in the first place; the more generous arc just made the wall
 * visually promise space near an inner corner that the game would still
 * kill you for using.
 *
 * Round 8 rewrote hasCrashed to real clamped distance-to-polyline (see
 * track.ts). On the *convex* (outer) side, this V-centered arc is exactly
 * that hitbox's boundary (a round-jointed offset polygon is the Minkowski
 * sum of the polyline with a disc of radius `h`). On the *concave* (inner)
 * side it is NOT exact — the real boundary there is the sharp shape round
 * 7 originally found (min-distance to each of the two straight segments,
 * which meet at a square corner past `V`, not a circle centered on it) —
 * this plain arc is a strictly smaller, more conservative safe area than
 * the true hitbox on that side (verified: a point can sit outside this
 * arc's radius yet still be well within `h` of the nearer straight wall).
 * That asymmetry is deliberate and harmless for the bug that mattered here
 * — it never draws a wall thinner than the real one, so it can't produce
 * "looks safe, still crashes"; it can only make a strip near an inner
 * corner look blocked when it's technically walkable, the opposite and far
 * less noticeable direction of error. Kept simple/symmetric anyway per an
 * explicit ask to drop round 7's exact-but-fiddly concave construction —
 * see PLAN.md's round-8 note.
 */
function filletVertex(
  path: Path2D,
  vertex: Vector,
  headingIn: Vector,
  headingOut: Vector,
  sign: 1 | -1,
  h: number,
  reverse: boolean,
): void {
  const lateralIn = rotate(headingIn, true);
  const lateralOut = rotate(headingOut, true);
  const footIn = addScaled(vertex, lateralIn, sign * h);
  const footOut = addScaled(vertex, lateralOut, sign * h);
  const first = reverse ? footOut : footIn;
  const second = reverse ? footIn : footOut;
  path.lineTo(first.x, first.y);
  arcBetween(path, vertex, first, second, h);
}

/**
 * The corridor as a filled offset polygon, not a stroked centerline — see
 * PLAN.md's round-7 note for why a stroke can't do this. Both boundaries
 * (the "right" one at +halfWidth along `rotate(heading, true)`, and the
 * "left" one at -halfWidth along the same axis) are filleted at every
 * interior vertex by `filletVertex` above with the same symmetric,
 * V-centered arc. Since round 8, track.ts's hasCrashed tests real clamped
 * distance to this same polyline, so this outline is exact against the
 * real hitbox on the convex (outer) side of every turn, and a slightly
 * conservative (safe-direction) approximation of it on the concave
 * (inner) side — see `filletVertex`'s own comment for the geometry and
 * PLAN.md's round-8 note. Computed once after the route is built, not per
 * frame — it's static for the whole run.
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
    filletVertex(path, points[i], headings[i - 1], headings[i], 1, h, false);
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
    filletVertex(path, points[i], headings[i - 1], headings[i], -1, h, true);
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
  // Camera-follow state (see CAMERA_SMOOTHING_SECONDS above). NaN means "not
  // yet initialized" — snap to the dot on the next draw() rather than lerping
  // from 0,0.
  let cameraX = Number.NaN;
  let cameraY = Number.NaN;
  let lastFrameMs = performance.now();

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
    cameraX = Number.NaN;
    cameraY = Number.NaN;
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

    const now = performance.now();
    const dt = Math.min((now - lastFrameMs) / 1000, 0.1);
    lastFrameMs = now;
    if (Number.isNaN(cameraX) || Number.isNaN(cameraY)) {
      cameraX = dot.x;
      cameraY = dot.y;
    } else {
      const follow = 1 - Math.exp(-dt / CAMERA_SMOOTHING_SECONDS);
      cameraX += (dot.x - cameraX) * follow;
      cameraY += (dot.y - cameraY) * follow;
    }

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 - cameraX, height / 2 - cameraY);

    // Corridor: the whole known route, drawn ahead and behind — seeing the
    // path coming is the reference game's own affordance, not a shortcut.
    // Filled offset polygon (buildCorridorOutline), not a stroked
    // centerline — its fillets, on both the inner and outer side of every
    // turn, are the same plain arc of radius CORRIDOR_HALF_WIDTH centered
    // on the route's own vertex (see buildCorridorOutline/filletVertex's
    // own comments for why this is cosmetic, not a hitbox claim).
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
