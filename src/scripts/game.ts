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
import { buildRouteShape } from "./route";
import { hasCrashed, linePosition } from "./track";

const MAX_ROUTE_SECONDS = 60;
const TRAIL_LENGTH = 240;
// Also the timing tolerance for a click, and the wrong-click-to-death lag —
// the same single number, since both are CORRIDOR_HALF_WIDTH / ROUTE_SPEED
// (route.ts): widening this widens the corridor, loosens how far off a
// click can land, and delays death, all at once, because the crash check
// (track.ts's hasCrashed) is purely spatial with no separate timing check.
// This coupling is deliberate, not a thing to split apart later — see
// PLAN.md's "Locked mechanic/UI invariants" section. 24/300 = 80ms here —
// looser than the previous 12 (40ms) for more room to be wrong, still
// under the ~100ms threshold past which click and death stop reading as
// simultaneous.
const CORRIDOR_HALF_WIDTH = 24;
// How long a decoration's flash lasts after the dot reaches it — the pulse
// that proves the route is actually tied to this track's rhythm, not just
// its turns (PLAN.md scope item 7).
const PULSE_DURATION_SECONDS = 0.25;
// Width of the player's own drawn line — clearly narrower than the corridor
// (CORRIDOR_HALF_WIDTH*2 = 48) so it never looks like it fills the
// corridor, but wide enough to read as an actual line with give, not a
// point (PLAN.md round 6).
const LINE_WIDTH = 14;

type TerminalState = "dead" | "finished";

export async function startGame(canvas: HTMLCanvasElement, trackUrl: string): Promise<void> {
  const { samples, sampleRate } = await loadMonoSamples(trackUrl);
  const trackDuration = samples.length / sampleRate;
  const onsets = detectOnsets(samples, sampleRate);
  const beats = markTurns(onsets);
  const route = buildRouteShape(beats, { maxDurationSeconds: Math.min(MAX_ROUTE_SECONDS, trackDuration) });

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
    ctx.strokeStyle = "#3a3f4b";
    ctx.lineWidth = CORRIDOR_HALF_WIDTH * 2;
    // Round, not miter: a round join's outer boundary is a literal arc of
    // radius CORRIDOR_HALF_WIDTH around the vertex, so it matches the actual
    // hitbox (hasCrashed's perpendicular distance) exactly at every corner —
    // a miter overshoots the true hitbox by ~10 world units at a 90° turn
    // (see PLAN.md), which read as "looks safe, isn't."
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    route.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();

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
