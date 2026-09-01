// Turns an audio file into onsets, then marks which of those onsets are
// strong/accented enough to require a turn — the rest are decoration only.
// Three layers, deliberately split:
//
//   - decodeToMono / loadMonoSamples: browser-only (needs AudioContext),
//     can't run under vitest's node environment.
//   - detectOnsets and its helpers: pure functions over a Float32Array of
//     samples, no DOM — this is what rhythm.test.ts exercises directly, and
//     what a browser sanity check calls after decoding a real track.
//   - markTurns: pure function over already-detected onsets, deciding which
//     become route corners (require a click) vs. visual-only decoration.
//
// The onset algorithm is deliberately simple: windowed RMS energy, a causal
// rolling average as an adaptive threshold, rising-edge detection, then a
// minimum-spacing filter. It's not a real beat-tracker (no tempo/downbeat
// estimation) — see PLAN.md for why that's the right scope here.
//
// Turn selection is grounded in how Dancing Line and rhythm-charting
// practice generally handle this (see PLAN.md's Status section for
// sources): early sections use only the strongest/most accented beats as
// turns (a tutorial-paced intro), and weaker onsets progressively qualify
// as turns as the track goes on — the difficulty ramp lives in *which*
// onsets require input, not in reaction-time tolerance.

export interface OnsetDetectionOptions {
  /** Width of each energy analysis window, in seconds. */
  windowSeconds?: number;
  /** Width of the causal rolling average used as the adaptive threshold, in seconds. */
  averageWindowSeconds?: number;
  /** An onset needs energy at least this many times the local rolling average. */
  thresholdFactor?: number;
  /** Minimum time between two accepted onsets, in seconds. */
  minSpacingSeconds?: number;
}

const DEFAULT_OPTIONS: Required<OnsetDetectionOptions> = {
  windowSeconds: 0.02,
  // Short enough to resolve individual note attacks in a dense, continuous
  // 16th-note run (~0.15s apart at a brisk tempo) instead of averaging a
  // whole run into one flat plateau it can no longer see rises against.
  averageWindowSeconds: 0.15,
  thresholdFactor: 1.2,
  minSpacingSeconds: 0.35,
};

/**
 * A window can only be an onset candidate if its energy also clears this
 * fraction of the *track's own* mean windowed energy — on top of the
 * relative-ratio check below. Without it, true (or near-)silence produces
 * a near-zero `localAverage`, so a single stray sample (mp3 decode
 * artifact, fade-in dither) divided by that near-zero average yields an
 * enormous ratio and gets mistaken for a huge accent. Scaling by the
 * track's own mean energy keeps this track-agnostic — no fixed absolute
 * amplitude to tune per track.
 */
const SILENCE_FLOOR_FRACTION = 0.02;

export interface Onset {
  /** Seconds since the start of the track. */
  time: number;
  /** How many times louder than the local ambient level this onset was — a proxy for accent strength. Larger = more accented. */
  strength: number;
}

/** Detect onsets (time + accent strength) in a mono sample buffer. Pure, no DOM. */
export function detectOnsets(samples: Float32Array, sampleRate: number, options: OnsetDetectionOptions = {}): Onset[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const windowSize = Math.max(1, Math.round(opts.windowSeconds * sampleRate));
  const energy = windowedEnergy(samples, windowSize);
  const averageSpan = Math.max(1, Math.round(opts.averageWindowSeconds / opts.windowSeconds));
  const silenceFloor = meanOf(energy) * SILENCE_FLOOR_FRACTION;
  const candidates = pickOnsetCandidates(energy, averageSpan, opts.thresholdFactor, silenceFloor);
  const onsets = candidates.map(({ index, strength }) => ({ time: index * opts.windowSeconds, strength }));
  return thinOnsets(onsets, opts.minSpacingSeconds);
}

/** RMS energy per non-overlapping window. */
function windowedEnergy(samples: Float32Array, windowSize: number): Float32Array {
  const windowCount = Math.max(1, Math.ceil(samples.length / windowSize));
  const energy = new Float32Array(windowCount);
  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSize;
    const end = Math.min(start + windowSize, samples.length);
    let sumSquares = 0;
    for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
    energy[w] = Math.sqrt(sumSquares / Math.max(1, end - start));
  }
  return energy;
}

/**
 * A window is an onset if it's a rising edge above `thresholdFactor` times
 * the average of the *preceding* `averageSpan` windows — causal, so an
 * onset only depends on the past, not on a peak that hasn't happened yet.
 * `strength` is that ratio (energy over local average), kept for accent
 * selection downstream.
 */
function pickOnsetCandidates(
  energy: Float32Array,
  averageSpan: number,
  thresholdFactor: number,
  silenceFloor: number,
): { index: number; strength: number }[] {
  const candidates: { index: number; strength: number }[] = [];
  let wasAboveThreshold = false;
  for (let i = 0; i < energy.length; i++) {
    const start = Math.max(0, i - averageSpan);
    let sum = 0;
    for (let j = start; j < i; j++) sum += energy[j];
    const count = i - start;
    const localAverage = count > 0 ? sum / count : energy[i];
    const strength = energy[i] / Math.max(localAverage, 1e-9);
    const isAbove = energy[i] > silenceFloor && strength > thresholdFactor;
    if (isAbove && !wasAboveThreshold) candidates.push({ index: i, strength });
    wasAboveThreshold = isAbove;
  }
  return candidates;
}

function meanOf(values: Float32Array): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Drop onsets that land closer than `minSpacingSeconds` to the previous
 * kept one — keeping whichever of the two colliding onsets is stronger,
 * not just whichever came first.
 */
function thinOnsets(onsets: Onset[], minSpacingSeconds: number): Onset[] {
  const kept: Onset[] = [];
  for (const onset of onsets) {
    const prev = kept[kept.length - 1];
    if (!prev || onset.time - prev.time >= minSpacingSeconds) {
      kept.push(onset);
    } else if (onset.strength > prev.strength) {
      kept[kept.length - 1] = onset;
    }
  }
  return kept;
}

export interface Beat extends Onset {
  /** Whether this onset is accented enough (given how far into the track it is) to require a turn. */
  isTurn: boolean;
}

export interface TurnRampOptions {
  /** Seconds over which the required accent percentile ramps from `startPercentile` down to `endPercentile`. */
  rampSeconds?: number;
  /** Required strength percentile (0–1) at t=0 — 0.9 means only the loudest 10% of onsets in the whole track qualify as turns this early. */
  startPercentile?: number;
  /** Required strength percentile once the ramp finishes — lower, so more (and weaker) onsets qualify as turns later on. */
  endPercentile?: number;
  /** No onset before this many seconds ever becomes a turn, regardless of strength — a fixed, unconditional "just watch" window before the player has to do anything, on top of the percentile ramp. */
  minStartSeconds?: number;
}

const DEFAULT_RAMP: Required<TurnRampOptions> = {
  rampSeconds: 30,
  startPercentile: 0.9,
  endPercentile: 0.45,
  minStartSeconds: 4.7,
};

/**
 * Marks which onsets are accented enough to become route corners (a turn
 * the player must act on) versus which stay visual-only decoration. The
 * bar an onset must clear drops linearly over `rampSeconds`, so the route
 * opens with only the strongest beats as turns and gradually admits
 * weaker ones — the difficulty ramp.
 */
export function markTurns(onsets: Onset[], options: TurnRampOptions = {}): Beat[] {
  if (onsets.length === 0) return [];
  const opts = { ...DEFAULT_RAMP, ...options };
  const sortedStrengths = onsets.map((o) => o.strength).sort((a, b) => a - b);
  const percentileOf = (strength: number): number => {
    let lo = 0;
    let hi = sortedStrengths.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedStrengths[mid] < strength) lo = mid + 1;
      else hi = mid;
    }
    return lo / sortedStrengths.length;
  };
  return onsets.map((onset) => {
    if (onset.time < opts.minStartSeconds) return { ...onset, isTurn: false };
    const progress = opts.rampSeconds > 0 ? Math.min(onset.time / opts.rampSeconds, 1) : 1;
    const requiredPercentile = opts.startPercentile + (opts.endPercentile - opts.startPercentile) * progress;
    return { ...onset, isTurn: percentileOf(onset.strength) >= requiredPercentile };
  });
}

/** Decode an audio file at `url` into mono samples. Browser-only (needs AudioContext). */
export async function loadMonoSamples(url: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextCtor();
  try {
    const audioBuffer = await context.decodeAudioData(arrayBuffer);
    return { samples: downmixToMono(audioBuffer), sampleRate: audioBuffer.sampleRate };
  } finally {
    void context.close();
  }
}

function downmixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  const mono = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) mono[i] += data[i] / numberOfChannels;
  }
  return mono;
}

/** Convenience: decode `url` and detect onsets in one call. Browser-only. */
export async function detectOnsetsFromUrl(url: string, options?: OnsetDetectionOptions): Promise<Onset[]> {
  const { samples, sampleRate } = await loadMonoSamples(url);
  return detectOnsets(samples, sampleRate, options);
}
