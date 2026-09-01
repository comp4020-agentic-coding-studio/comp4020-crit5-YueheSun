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
import { buildRouteShape, positionAtTime } from "./route";
import { runRoute, CORNER_TOLERANCE_SECONDS } from "./track";

const MAX_ROUTE_SECONDS = 60;
const TRAIL_LENGTH = 240;
const BEAT_PULSE_WINDOW_SECONDS = 0.1;
const CORRIDOR_HALF_WIDTH = 34;

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
      terminal = "dead";
      audio.pause();
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

  function nearestBeatFlash(): number {
    let closest = Infinity;
    for (const t of route.turnTimes) closest = Math.min(closest, Math.abs(elapsed - t));
    for (const d of route.decorations) closest = Math.min(closest, Math.abs(elapsed - d.time));
    if (closest >= BEAT_PULSE_WINDOW_SECONDS) return 0;
    return 1 - closest / BEAT_PULSE_WINDOW_SECONDS;
  }

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
    // The beat pulse lives here (not as a full-screen flash, which read as
    // distracting) — it brightens the corridor itself at each detected beat.
    const flash = nearestBeatFlash();
    const c = 58 + Math.round(flash * 110);
    ctx.strokeStyle = flash > 0 ? `rgb(${c}, ${c}, ${c + 20})` : "#3a3f4b";
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
