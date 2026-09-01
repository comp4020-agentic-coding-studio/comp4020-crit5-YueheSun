import { describe, expect, it } from "vitest";
import { detectOnsets, markTurns, type Onset } from "./rhythm";

// Sanity checks for the onset-detection algorithm on synthetic data. This is
// not the spec's required "one rule under a focused automated test" — that's
// reserved for the game's collision/turn rule (see PLAN.md) — but the
// algorithm is nontrivial enough to want its own contract test before it
// feeds a route generator.

const SAMPLE_RATE = 1000; // low rate keeps synthetic buffers small and fast

/** Silence, except for a burst of amplitude `peak` at each given time (seconds). */
function bufferWithBurstsAt(durationSeconds: number, burstTimes: number[], burstSeconds = 0.08, peak = 1): Float32Array {
  const samples = new Float32Array(Math.round(durationSeconds * SAMPLE_RATE));
  for (const t of burstTimes) {
    const start = Math.round(t * SAMPLE_RATE);
    const end = Math.round((t + burstSeconds) * SAMPLE_RATE);
    for (let i = start; i < end && i < samples.length; i++) {
      // deterministic "noise": alternating full-scale samples, not actual randomness
      samples[i] = i % 2 === 0 ? peak : -peak;
    }
  }
  return samples;
}

describe("detectOnsets", () => {
  it("finds no onsets in silence", () => {
    const samples = new Float32Array(SAMPLE_RATE * 3);
    expect(detectOnsets(samples, SAMPLE_RATE)).toEqual([]);
  });

  it("finds one onset per isolated burst, near the burst's start time", () => {
    const burstTimes = [1, 2, 3, 4];
    const samples = bufferWithBurstsAt(5, burstTimes);
    const onsets = detectOnsets(samples, SAMPLE_RATE);

    expect(onsets).toHaveLength(burstTimes.length);
    onsets.forEach((onset, i) => {
      expect(onset.time).toBeGreaterThanOrEqual(burstTimes[i]);
      expect(onset.time).toBeLessThan(burstTimes[i] + 0.1);
      expect(onset.strength).toBeGreaterThan(1);
    });
  });

  it("collapses onsets closer together than minSpacingSeconds", () => {
    // Two bursts 0.15s apart, well under the 0.35s default spacing.
    const samples = bufferWithBurstsAt(2, [1, 1.15]);
    const onsets = detectOnsets(samples, SAMPLE_RATE);
    expect(onsets).toHaveLength(1);
  });

  it("keeps the stronger of two colliding onsets", () => {
    // A loud burst at 1s and a much quieter one at 1.15s, colliding under
    // the default 0.35s spacing — the loud one should win, not the earlier one.
    const samples = bufferWithBurstsAt(2, [1], 0.08, 1);
    const quietStart = Math.round(1.15 * SAMPLE_RATE);
    const quietEnd = Math.round(1.23 * SAMPLE_RATE);
    for (let i = quietStart; i < quietEnd; i++) samples[i] = i % 2 === 0 ? 0.05 : -0.05;

    const onsets = detectOnsets(samples, SAMPLE_RATE);
    expect(onsets).toHaveLength(1);
    expect(onsets[0].time).toBeGreaterThanOrEqual(1);
    expect(onsets[0].time).toBeLessThan(1.1);
  });

  it("keeps onsets spaced further apart than minSpacingSeconds", () => {
    const samples = bufferWithBurstsAt(3, [1, 1.5]);
    const onsets = detectOnsets(samples, SAMPLE_RATE, { minSpacingSeconds: 0.35 });
    expect(onsets).toHaveLength(2);
  });

  it("respects a custom thresholdFactor and minSpacingSeconds", () => {
    const samples = bufferWithBurstsAt(2, [0.5, 1.0]);
    const onsets = detectOnsets(samples, SAMPLE_RATE, { thresholdFactor: 1.2, minSpacingSeconds: 0.2 });
    expect(onsets.length).toBeGreaterThan(0);
  });
});

describe("markTurns", () => {
  function onset(time: number, strength: number): Onset {
    return { time, strength };
  }

  it("returns nothing for an empty onset list", () => {
    expect(markTurns([])).toEqual([]);
  });

  it("only the strongest onsets become turns right at the start of the track", () => {
    // Ten onsets at t=0, strengths spread across the range — with the
    // default startPercentile 0.9, only the very strongest should turn.
    const strengths = [2, 3, 4, 5, 6, 7, 8, 9, 10, 20];
    const onsets = strengths.map((s) => onset(0, s));
    const beats = markTurns(onsets);
    const turnCount = beats.filter((b) => b.isTurn).length;
    expect(turnCount).toBeLessThanOrEqual(2);
    expect(beats[beats.length - 1].isTurn).toBe(true); // the strongest one
  });

  it("admits more onsets as turns once the ramp finishes", () => {
    const strengths = [2, 3, 4, 5, 6, 7, 8, 9, 10, 20];
    // Same strength distribution, but every onset is past the ramp window.
    const onsets = strengths.map((s) => onset(1000, s));
    const beats = markTurns(onsets, { rampSeconds: 30 });
    const turnCount = beats.filter((b) => b.isTurn).length;
    expect(turnCount).toBeGreaterThan(2);
  });

  it("a mid-strength onset can become a turn later without getting any stronger", () => {
    // 10 evenly-spaced strengths: at t=0 (requiredPercentile 0.9) only the
    // top one qualifies; at t=30 (requiredPercentile 0.45) the top half does.
    // Index 5 sits right on that boundary — not a turn early, but a turn late.
    const distribution = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const midIndex = 5;
    const early = markTurns(
      distribution.map((s) => onset(0, s)),
      { rampSeconds: 30 },
    );
    const late = markTurns(
      distribution.map((s) => onset(30, s)),
      { rampSeconds: 30 },
    );
    expect(early[midIndex].isTurn).toBe(false);
    expect(late[midIndex].isTurn).toBe(true);
  });
});
