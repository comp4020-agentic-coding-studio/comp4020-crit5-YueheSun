// Dev-only manual verification tool for src/scripts/rhythm.ts's onset
// detection and turn selection: play the track and see AND hear the
// detected beats against the real audio at the same time — a visual
// timeline with a moving playhead, plus an audible click scheduled at
// every beat and layered on top of the actual song. Turns (beats that
// require a click) and decoration (visual-only, no click required) are
// drawn and sounded differently so it's obvious at a glance whether the
// turn/decoration split — and its difficulty ramp — looks right. Not part
// of the game; mounted only when import.meta.env.DEV is true (see
// main.ts), and it builds its own DOM at runtime with inline styles so
// nothing here touches index.astro or its scoped styles.

import { loadMonoSamples, detectOnsets, markTurns } from "./rhythm";

export async function mountRhythmDebugger(trackUrl: string, trackName: string): Promise<void> {
  const { samples, sampleRate } = await loadMonoSamples(trackUrl);
  const duration = samples.length / sampleRate;
  const onsets = detectOnsets(samples, sampleRate);
  const beats = markTurns(onsets);
  const turnCount = beats.filter((b) => b.isTurn).length;

  const gaps = beats.slice(1).map((b, i) => b.time - beats[i].time);
  const mean = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  console.log(
    `[rhythm] ${trackName}: duration ${duration.toFixed(1)}s, ${beats.length} onsets (${turnCount} turns), ` +
      `gap min/mean/max = ${gaps.length ? Math.min(...gaps).toFixed(2) : "-"}/${mean.toFixed(2)}/${gaps.length ? Math.max(...gaps).toFixed(2) : "-"}s`,
  );

  const { root, audio, canvas, status } = buildUI(trackName, duration, beats.length, turnCount);
  document.body.prepend(root);
  audio.src = trackUrl;
  const ctx2d = canvas.getContext("2d")!;

  const audioCtx = new AudioContext();
  let scheduledClicks: OscillatorNode[] = [];

  function clearScheduledClicks() {
    for (const osc of scheduledClicks) {
      try {
        osc.stop();
      } catch {
        // already stopped/ended — fine to ignore
      }
    }
    scheduledClicks = [];
  }

  function scheduleClicksFrom(offsetSeconds: number) {
    clearScheduledClicks();
    const leadIn = 0.05; // tiny lead-in so the first click isn't clipped
    const startCtxTime = audioCtx.currentTime + leadIn;
    for (const beat of beats) {
      if (beat.time < offsetSeconds) continue;
      scheduledClicks.push(playClickAt(audioCtx, startCtxTime + (beat.time - offsetSeconds), beat.isTurn));
    }
  }

  audio.addEventListener("play", () => scheduleClicksFrom(audio.currentTime));
  audio.addEventListener("seeked", () => {
    if (!audio.paused) scheduleClicksFrom(audio.currentTime);
  });
  audio.addEventListener("pause", clearScheduledClicks);
  audio.addEventListener("ended", clearScheduledClicks);

  function draw() {
    const width = canvas.width;
    const height = canvas.height;
    ctx2d.clearRect(0, 0, width, height);

    ctx2d.strokeStyle = "#c4c4c4";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, height / 2);
    ctx2d.lineTo(width, height / 2);
    ctx2d.stroke();

    for (const beat of beats) {
      const x = (beat.time / duration) * width;
      const isNear = Math.abs(audio.currentTime - beat.time) < 0.1;
      if (beat.isTurn) {
        // Turn: tall, saturated tick — flashes brighter as the playhead passes.
        ctx2d.strokeStyle = isNear ? "#ff3b30" : "#1a5fb4";
        ctx2d.lineWidth = isNear ? 3 : 2;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 4);
        ctx2d.lineTo(x, height - 4);
        ctx2d.stroke();
      } else {
        // Decoration: short, pale tick — no click required here.
        ctx2d.strokeStyle = isNear ? "#ffb199" : "#c9d8ee";
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.moveTo(x, height / 2 - 12);
        ctx2d.lineTo(x, height / 2 + 12);
        ctx2d.stroke();
      }
    }

    const playheadX = (audio.currentTime / duration) * width;
    ctx2d.strokeStyle = "#111";
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(playheadX, 0);
    ctx2d.lineTo(playheadX, height);
    ctx2d.stroke();

    status.textContent = `${audio.currentTime.toFixed(1)}s / ${duration.toFixed(1)}s — ${beats.length} onsets, ${turnCount} turns`;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

/** A short blip at every beat — sharp and loud for a turn, soft and low for decoration. */
function playClickAt(ctx: AudioContext, when: number, isTurn: boolean): OscillatorNode {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = isTurn ? 1800 : 900;
  const peak = isTurn ? 0.4 : 0.12;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peak, when + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.04);
  osc.connect(gain).connect(ctx.destination);
  osc.start(when);
  osc.stop(when + 0.05);
  return osc;
}

function buildUI(trackName: string, duration: number, beatCount: number, turnCount: number) {
  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "relative",
    zIndex: "1000",
    background: "#fafafa",
    border: "2px solid #222",
    borderRadius: "8px",
    padding: "12px 16px",
    margin: "12px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    color: "#111",
  } satisfies Partial<CSSStyleDeclaration>);

  const heading = document.createElement("div");
  heading.textContent = `[DEV] rhythm debugger — ${trackName} (${duration.toFixed(1)}s, ${beatCount} onsets, ${turnCount} turns)`;
  heading.style.fontWeight = "bold";
  heading.style.marginBottom = "6px";

  const hint = document.createElement("div");
  hint.textContent =
    "Press play. Tall blue ticks = turns (a click is required here, loud high click); short pale ticks = decoration only (soft low click, no click required from the player). Ticks flash as the playhead passes.";
  hint.style.marginBottom = "8px";
  hint.style.color = "#444";

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.style.width = "100%";
  audio.style.marginBottom = "8px";

  const canvas = document.createElement("canvas");
  canvas.width = Math.min(window.innerWidth - 80, 1000);
  canvas.height = 100;
  canvas.style.width = "100%";
  canvas.style.height = "100px";
  canvas.style.display = "block";
  canvas.style.background = "#fff";
  canvas.style.border = "1px solid #ddd";

  const status = document.createElement("div");
  status.style.marginTop = "6px";
  status.style.color = "#666";

  root.append(heading, hint, audio, canvas, status);
  return { root, audio, canvas, status };
}
