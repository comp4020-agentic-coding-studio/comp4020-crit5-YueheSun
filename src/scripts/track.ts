// The one core game rule: has the player's line crashed into the corridor
// wall? Pure, no DOM/canvas/audio — this is what spec/game-rule.test.ts
// exercises directly (the C5 spec's required "one rule under a focused
// automated test"), and what the live render loop calls every frame.
//
// The corridor and the player's line both walk forward at the same
// constant speed, turning 90° at a sequence of timestamps (route.ts's
// walkTurns) — the corridor turns at its beat-derived cornerTimes, the
// line turns at the player's clickTimes. Because both always cover the
// same distance by the same elapsed time, "is the line touching a wall"
// reduces to: how far sideways (perpendicular to the corridor's current
// direction) has the line drifted from the corridor's centerline?
// Exceeding the corridor's half-width is a wall hit.

import { walkTurns, positionAtTime, headingAt, rotate, ROUTE_SPEED } from "./route";

/** The most recent corner time at or before `time` — 0 if none yet. This is
 * when the corridor last turned, i.e. the start of whichever segment `time`
 * currently falls in. */
function segmentStart(cornerTimes: number[], time: number): number {
  let start = 0;
  for (const t of cornerTimes) {
    if (t > time) break;
    start = t;
  }
  return start;
}

/** Raw world-space line-vs-corridor difference at `time`, with no per-segment
 * correction applied — a running total from t=0. */
function rawDiff(cornerTimes: number[], clickTimes: number[], time: number, speed: number) {
  const corridor = walkTurns(cornerTimes, time, speed);
  const line = walkTurns(clickTimes, time, speed);
  const corridorPos = positionAtTime(corridor, time);
  const linePos = positionAtTime(line, time);
  return { x: linePos.x - corridorPos.x, y: linePos.y - corridorPos.y };
}

/** `rawDiff(time)` relative to `rawDiff(baselineTime)` — zero exactly at
 * `baselineTime`, growing only from whatever happens after it. */
function localOffsetVector(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  baselineTime: number,
  speed: number,
) {
  const cur = rawDiff(cornerTimes, clickTimes, time, speed);
  const base = rawDiff(cornerTimes, clickTimes, baselineTime, speed);
  return { x: cur.x - base.x, y: cur.y - base.y };
}

/**
 * Signed sideways distance between the player's actual line and the ideal
 * corridor, at `time`, measured along the corridor's current direction of
 * travel. Zero means the line is exactly on the centerline; the sign
 * indicates which side.
 *
 * Measured *within the current segment only*: the raw line-vs-corridor
 * difference is a running total from t=0, so without correction, leftover
 * drift from an already-survived turn would sit as a permanent offset that
 * eats into the next turn's own tolerance (a near-miss compounding forward
 * forever, since a 90° turn rotates "along the old segment" into "sideways
 * on the new one"). Subtracting the same raw difference evaluated at the
 * segment's start resets that baseline to zero every time the corridor
 * turns, so each turn is judged only on what happened since it began —
 * matching Dancing Line's own re-centering after each turn.
 */
export function lateralOffset(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  speed: number = ROUTE_SPEED,
): number {
  const segStart = segmentStart(cornerTimes, time);
  const local = localOffsetVector(cornerTimes, clickTimes, time, segStart, speed);
  const corridor = walkTurns(cornerTimes, time, speed);
  const heading = headingAt(corridor, time);
  const lateral = rotate(heading, true); // perpendicular to the corridor's own heading
  return local.x * lateral.x + local.y * lateral.y;
}

/**
 * Where the player's line should actually be drawn: the corridor's own
 * position at `time`, offset sideways by however far the line has drifted
 * — both walk at the same constant speed, so there's never a meaningful
 * "ahead/behind" to show, only how far off-center the line is. This keeps
 * the render and the crash check as one source of truth (see PLAN.md's
 * round-5 note on the corner-rendering bug that came from letting them
 * disagree).
 *
 * `lateralOffset` resets discontinuously at each turn (by design — see its
 * own comment), so this does too: the drawn line snaps back to centerline
 * at the instant a survived near-miss's segment ends, matching the
 * corridor's own instant 90° direction change. (A cross-turn smoothing
 * blend was tried and reverted — see PLAN.md round 6 — it interpolated
 * straight-line between offsets measured on two *perpendicular* axes,
 * which drew a diagonal shortcut across the inside of every corner.)
 */
export function linePosition(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  speed: number = ROUTE_SPEED,
): { x: number; y: number } {
  const corridor = walkTurns(cornerTimes, time, speed);
  const corridorPos = positionAtTime(corridor, time);
  const heading = headingAt(corridor, time);
  const lateral = rotate(heading, true);
  const offset = lateralOffset(cornerTimes, clickTimes, time, speed);
  return { x: corridorPos.x + lateral.x * offset, y: corridorPos.y + lateral.y * offset };
}

/** Has the line drifted far enough sideways to be touching/past a wall? */
export function hasCrashed(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  halfWidth: number,
  speed: number = ROUTE_SPEED,
): boolean {
  return Math.abs(lateralOffset(cornerTimes, clickTimes, time, speed)) > halfWidth;
}
