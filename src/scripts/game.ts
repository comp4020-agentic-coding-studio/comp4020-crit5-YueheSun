// The actual game: loads a track, generates its route, and runs the
// canvas renderer + input loop around track.ts's already-tested
// runRoute/resolveCorner. This is where onset detection (rhythm.ts), turn
// selection (rhythm.ts), route shape (route.ts), and the pure game rule
// (track.ts) all come together for the first time — everything upstream of
// this file is pure/tested; this file is the DOM/canvas/audio glue.
//
// Deliberately NOT included yet: the end-of-run zoom-to-top-down tween
// (PLAN.md step 5) — that's the next step, after a human playtests this.

import { loadMonoSamples, detectOnsets, markTurns } from "./rhythm";
import { buildRouteShape, positionAtTime, ROUTE_SPEED } from "./route";
import { runRoute } from "./track";

const MAX_ROUTE_SECONDS = 60;
const TRAIL_LENGTH = 240;
const CORRIDOR_HALF_WIDTH = 34;
// The actual forgiveness a player gets, derived from the visual corridor
// width rather than track.ts's default — so "how wide the track looks" and
// "how late/early a click can land" are the same knob, not two numbers that
// can silently drift apart (the previous bug: widening the corridor changed
// nothing about what actually counted as a hit).
const CORNER_TOLERANCE_SECONDS = CORRIDOR_HALF_WIDTH / ROUTE_SPEED;

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
    const due = route.turnTimes.filter((t) => t <= elapsed);
    const result = runRoute(due, clickTimes, CORNER_TOLERANCE_SECONDS);
    if (result.state === "dead") {
      const cornerAt = due[result.failedAt!];
      // due only means "the corner's nominal instant has passed" — that's
      // not the same as "the player is out of time for it." A missing
      // click (as opposed to one that already landed wrong) isn't a real
      // failure until its own late-click window has actually closed;
      // judging it the moment elapsed reaches the corner killed runs before
      // a legitimately-late-but-in-tolerance click could ever land.
      const hasClick = clickTimes.length > result.failedAt!;
      const deadlinePassed = elapsed > cornerAt + CORNER_TOLERANCE_SECONDS;
      if (hasClick || deadlinePassed) {
        terminal = "dead";
        audio.pause();
      }
      return;
    }
    if (due.length === route.turnTimes.length && elapsed >= route.duration) {
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
    const dot = positionAtTime(route.points, Math.min(elapsed, route.duration));

    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2 - dot.x, height / 2 - dot.y);

    // Corridor: the whole known route, drawn ahead and behind — seeing the
    // path coming is the reference game's own affordance, not a shortcut.
    ctx.strokeStyle = "#3a3f4b";
    ctx.lineWidth = CORRIDOR_HALF_WIDTH * 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    route.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();

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
      trail.push(positionAtTime(route.points, Math.min(elapsed, route.duration)));
      if (trail.length > TRAIL_LENGTH) trail.shift();
      checkState();
    }
    draw();
  }
  requestAnimationFrame(loop);
}
