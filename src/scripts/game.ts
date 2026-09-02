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
import { buildRouteShape, rotate, positionAtTime, headingAt, type RoutePoint } from "./route";
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
// Same follow filter, but slower — used only once terminal is set, so the
// end-of-run pull-back reads as a deliberate camera move, not a snap.
const ZOOM_SMOOTHING_SECONDS = 0.6;
// The four discrete checkpoints stamped directly on the corridor (a
// perpendicular band across its full width) instead of a screen-space HUD
// bar — the corridor itself is where the player is already looking.
const PROGRESS_FRACTIONS = [0.2, 0.4, 0.6, 0.8];
// How far outside the corridor's own edge (CORRIDOR_HALF_WIDTH) each
// percentage label sits, so it reads as a landmark beside the track rather
// than something drawn on the playable surface itself.
const PROGRESS_LABEL_MARGIN = 36;
// Extra headroom around the traveled path's bounding box for the end-of-run
// zoom-to-fit, so the corridor's own width (and the line's rendered width on
// top of it) doesn't get clipped right at the frame edge.
const ZOOM_PADDING = CORRIDOR_HALF_WIDTH * 3;

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

/**
 * The entire path the player's line actually traveled, from the run's start
 * to `duration` (the moment it ended) — unlike the live `trail` in
 * `startGame`, which is capped to the last few seconds for the fading-tail
 * look, this samples the whole run for the end-of-run pull-back. Resamples
 * `linePosition` at a fixed step rather than recording every live frame, so
 * it's exact regardless of the run's actual framerate.
 */
function sampleFullTrail(cornerTimes: number[], clickTimes: number[], duration: number): Vector[] {
  const step = 1 / 60;
  const points: Vector[] = [];
  for (let t = 0; t < duration; t += step) points.push(linePosition(cornerTimes, clickTimes, t));
  points.push(linePosition(cornerTimes, clickTimes, duration));
  return points;
}

/** The camera position + scale that fits every one of `points` on screen,
 * with `padding` world units of headroom on every side — never zoomed in
 * past 1x, only ever out. */
function fitCamera(points: Vector[], width: number, height: number, padding: number): { x: number; y: number; scale: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const spanX = Math.max(maxX - minX, 1) + padding * 2;
  const spanY = Math.max(maxY - minY, 1) + padding * 2;
  const scale = Math.min(width / spanX, height / spanY, 1);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale };
}

export async function startGame(canvas: HTMLCanvasElement, trackUrl: string): Promise<void> {
  const { samples, sampleRate } = await loadMonoSamples(trackUrl);
  const trackDuration = samples.length / sampleRate;
  const onsets = detectOnsets(samples, sampleRate);
  const beats = markTurns(onsets);
  const route = buildRouteShape(beats, { maxDurationSeconds: Math.min(MAX_ROUTE_SECONDS, trackDuration) });
  const corridorOutline = buildCorridorOutline(route.points, CORRIDOR_HALF_WIDTH);
  // Progress markers: computed once, like the corridor itself — a fixed
  // property of the route, not something that changes frame to frame.
  const progressMarkers = PROGRESS_FRACTIONS.map((fraction) => {
    const time = route.duration * fraction;
    const pos = positionAtTime(route.points, time);
    // Always offset to the same fixed side (rotate(..., true)) rather than
    // "whichever side has more room" — simple and deterministic, matching
    // how the corridor's own +halfWidth boundary is chosen in
    // buildCorridorOutline.
    const lateral = rotate(headingAt(route.points, time), true);
    const label = addScaled(pos, lateral, CORRIDOR_HALF_WIDTH + PROGRESS_LABEL_MARGIN);
    return { time, fraction, x: label.x, y: label.y };
  });

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
  // Set only once terminal is reached (see enterTerminal below): camScale
  // starts at 1 (live gameplay is never zoomed) and only the end-of-run
  // pull-back ever changes it. fullTrail is the *entire* traveled path, for
  // the end screen — distinct from the capped, fading `trail` above, which
  // is a live-only visual and not what the pull-back should frame.
  let camScale = 1;
  let zoomTarget: { x: number; y: number; scale: number } | null = null;
  let fullTrail: Vector[] = [];

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
    camScale = 1;
    zoomTarget = null;
    fullTrail = [];
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

  // Run once, the instant the run ends. A finish gets the "camera pulls
  // back to a top-down view of the whole path traveled" reveal: snapshot
  // the traveled path and the camera framing that fits it, and draw()'s
  // per-frame tween does the rest. A death gets neither — per the user's
  // correction, it should freeze exactly where it was, dot turned red, no
  // pull-back — so it's left at the plain "line's head turns red, screen
  // freezes" behavior from before round 9's pull-back existed.
  function enterTerminal(state: TerminalState) {
    terminal = state;
    audio.pause();
    if (state === "finished") {
      const finalTime = Math.min(elapsed, route.duration);
      fullTrail = sampleFullTrail(route.turnTimes, clickTimes, finalTime);
      zoomTarget = fitCamera(fullTrail, window.innerWidth, window.innerHeight, ZOOM_PADDING);
    }
  }

  function checkState() {
    if (hasCrashed(route.turnTimes, clickTimes, elapsed, CORRIDOR_HALF_WIDTH)) {
      enterTerminal("dead");
      return;
    }
    if (elapsed >= route.duration) {
      enterTerminal("finished");
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
    // Live gameplay follows the dot at 1x. A finish switches the target to
    // the fitted end-of-run framing, with the slower ZOOM_SMOOTHING_SECONDS
    // so it reads as a deliberate pull-back — same exponential-lerp
    // mechanism, just chasing a different, fixed point. A death gets none of
    // that: it keeps chasing the (now frozen, since elapsed stops advancing)
    // dot at 1x, same as live gameplay, so the camera simply stops moving
    // where it already was rather than tweening anywhere.
    const pullBack = terminal === "finished" ? zoomTarget : null;
    const desiredScale = pullBack ? pullBack.scale : 1;
    const desiredX = pullBack ? pullBack.x : dot.x;
    const desiredY = pullBack ? pullBack.y : dot.y;
    const smoothingSeconds = pullBack ? ZOOM_SMOOTHING_SECONDS : CAMERA_SMOOTHING_SECONDS;
    if (Number.isNaN(cameraX) || Number.isNaN(cameraY)) {
      cameraX = desiredX;
      cameraY = desiredY;
      camScale = desiredScale;
    } else {
      const follow = 1 - Math.exp(-dt / smoothingSeconds);
      cameraX += (desiredX - cameraX) * follow;
      cameraY += (desiredY - cameraY) * follow;
      camScale += (desiredScale - camScale) * follow;
    }

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(camScale, camScale);
    ctx.translate(-cameraX, -cameraY);

    // Corridor: the whole known route, drawn ahead and behind — seeing the
    // path coming is the reference game's own affordance, not a shortcut.
    // Filled offset polygon (buildCorridorOutline), not a stroked
    // centerline — its fillets, on both the inner and outer side of every
    // turn, are the same plain arc of radius CORRIDOR_HALF_WIDTH centered
    // on the route's own vertex (see buildCorridorOutline/filletVertex's
    // own comments for why this is cosmetic, not a hitbox claim).
    ctx.fillStyle = "#3a3f4b";
    ctx.fill(corridorOutline);

    // Progress markers: a plain percentage label beside the corridor at
    // 20/40/60/80% of the route — a landmark next to the track, not
    // anything drawn on the playable surface itself. Left unrotated (world
    // space here is never rotated, only translated/scaled, so upright text
    // stays upright on screen regardless of which way the corridor is
    // heading at that point) so it reads the same at every turn. Large and
    // dark-outlined (a stroke behind the fill) so it pops against both the
    // dark background and the corridor's own gray, at a glance rather than
    // needing to be read closely. Brightens permanently once passed.
    ctx.font = "bold 34px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const marker of progressMarkers) {
      const passed = clampedElapsed >= marker.time;
      const label = `${Math.round(marker.fraction * 100)}%`;
      ctx.lineWidth = 6;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
      ctx.strokeText(label, marker.x, marker.y);
      ctx.fillStyle = passed ? "#ffd65c" : "rgba(255, 255, 255, 0.55)";
      ctx.fillText(label, marker.x, marker.y);
    }
    ctx.textAlign = "left";

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
    // bare point relocating. Live gameplay draws the capped, fading `trail`
    // as before; on a successful finish, switch to the *entire* traveled
    // path instead (fullTrail, snapshotted in enterTerminal) as one solid
    // stroke — that's the "whole path traveled" the end-of-run pull-back is
    // framing. A death doesn't get that reveal (nothing to show off), so it
    // keeps drawing the same capped `trail` it was using at the moment it
    // died — the loop stops pushing to it once terminal is set, so it just
    // holds still instead of continuing to fade.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (terminal !== "finished") {
      for (let i = 1; i < trail.length; i++) {
        const alpha = (i + 1) / trail.length;
        ctx.strokeStyle = `rgba(255, 214, 92, ${alpha * 0.8})`;
        ctx.lineWidth = LINE_WIDTH;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = "rgba(255, 214, 92, 0.85)";
      ctx.lineWidth = LINE_WIDTH;
      ctx.beginPath();
      for (let i = 0; i < fullTrail.length; i++) {
        const p = fullTrail[i];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // The dot itself.
    ctx.fillStyle = terminal === "dead" ? "#ff3b30" : "#ffd65c";
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Success title, screen-space (drawn after ctx.restore(), so it's fixed
    // to the top of the viewport rather than panning/zooming with the
    // pulled-back camera below it) — a death gets the pull-back too, per
    // round 9, but no title: there's nothing to announce.
    if (terminal === "finished") {
      ctx.font = "bold 48px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#ffd65c";
      ctx.fillText("SUCCESS", width / 2, 32);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
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
