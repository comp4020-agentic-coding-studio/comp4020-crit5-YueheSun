// The actual game: loads a track, generates its route, and runs the
// canvas renderer + input loop around track.ts's already-tested
// hasCrashed. This is where onset detection (rhythm.ts), turn selection
// (rhythm.ts), route shape (route.ts), and the pure game rule (track.ts)
// all come together for the first time — everything upstream of this file
// is pure/tested; this file is the DOM/canvas/audio glue.
//
// The corridor (route.points) is the fixed, beat-derived shape. The
// player's line is its own live path, walked forward from clickTimes (see
// walkTurns in route.ts) — it only matches the corridor's shape when
// clicks land where the corridor actually turns. hasCrashed checks every
// frame whether the line has drifted sideways past the corridor's wall.
//
// Deliberately NOT included yet: the end-of-run zoom-to-top-down tween
// (PLAN.md step 5) — that's the next step, after a human playtests this.

import { loadMonoSamples, detectOnsets, markTurns } from "./rhythm";
import { buildRouteShape, positionAtTime, walkTurns } from "./route";
import { hasCrashed } from "./track";

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
    const dot = positionAtTime(walkTurns(clickTimes, clampedElapsed), clampedElapsed);

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 - dot.x, height / 2 - dot.y);

    // Corridor: the whole known route, drawn ahead and behind — seeing the
    // path coming is the reference game's own affordance, not a shortcut.
    ctx.strokeStyle = "#3a3f4b";
    ctx.lineWidth = CORRIDOR_HALF_WIDTH * 2;
    ctx.lineJoin = "miter";
    ctx.miterLimit = 2; // segments only ever meet at 90°, so miters never spike
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

    // Fading trail of where the dot has actually been.
    for (let i = 0; i < trail.length; i++) {
      const alpha = (i + 1) / trail.length;
      ctx.fillStyle = `rgba(255, 214, 92, ${alpha * 0.8})`;
      ctx.beginPath();
      ctx.arc(trail[i].x, trail[i].y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // The dot itself.
    ctx.fillStyle = terminal === "dead" ? "#ff3b30" : "#ffd65c";
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

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
      trail.push(positionAtTime(walkTurns(clickTimes, clampedElapsed), clampedElapsed));
      if (trail.length > TRAIL_LENGTH) trail.shift();
      checkState();
    }
    draw();
  }
  requestAnimationFrame(loop);
}
