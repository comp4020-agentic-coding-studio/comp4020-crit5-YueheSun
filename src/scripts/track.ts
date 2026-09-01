// The one core game rule: did the player turn in time at each corner in the
// route? Pure, no DOM/canvas/audio — this is what spec/game-rule.test.ts
// exercises directly (the C5 spec's required "one rule under a focused
// automated test"), and what the live render loop (later) calls as clicks
// and corners happen in real time.
//
// Corners and clicks are both plain timestamps in seconds since the run
// started. The line moves at a constant forward speed, so time is a direct
// stand-in for distance along the route — no separate distance unit needed,
// and a route's corner times can come straight from rhythm.ts's onsets.

export const CORNER_TOLERANCE_SECONDS = 0.15;

export type RunState = "dead" | "finished";

export interface RunResult {
  state: RunState;
  /** Index into cornerTimes of the corner that ended the run, if `state` is "dead". */
  failedAt?: number;
}

/** Does a click at `clickAt` count as turning at the corner at `cornerAt`? */
export function resolveCorner(
  cornerAt: number,
  clickAt: number | undefined,
  tolerance: number = CORNER_TOLERANCE_SECONDS,
): boolean {
  // The tiny epsilon absorbs float rounding at the exact tolerance boundary
  // (e.g. 5 - 0.15 isn't exactly representable), not a gameplay looseness.
  return clickAt !== undefined && Math.abs(clickAt - cornerAt) <= tolerance + 1e-9;
}

/**
 * Replays a full route against a full stream of click timestamps and
 * returns how the run ended. Both `cornerTimes` and `clickTimes` must be
 * sorted ascending (both are natural time-order sequences).
 *
 * The rule: each corner consumes the next unconsumed click. A click that
 * arrives well before the next corner's tolerance window is a stray turn —
 * off the corridor on a straight stretch — so it ends the run just as a
 * missing click would, at the corner it never reached in time.
 */
export function runRoute(
  cornerTimes: number[],
  clickTimes: number[],
  tolerance: number = CORNER_TOLERANCE_SECONDS,
): RunResult {
  let clickIndex = 0;
  for (let cornerIndex = 0; cornerIndex < cornerTimes.length; cornerIndex++) {
    const cornerAt = cornerTimes[cornerIndex];
    const nextClick = clickTimes[clickIndex];
    const isStray = nextClick !== undefined && nextClick < cornerAt - tolerance;
    const candidate = isStray ? undefined : nextClick;
    if (!resolveCorner(cornerAt, candidate, tolerance)) {
      return { state: "dead", failedAt: cornerIndex };
    }
    clickIndex++;
  }
  return { state: "finished" };
}
