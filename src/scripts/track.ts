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

/**
 * Signed sideways distance between the player's actual line and the ideal
 * corridor, at `time`, measured along the corridor's current direction of
 * travel. Zero means the line is exactly on the centerline; the sign
 * indicates which side.
 */
export function lateralOffset(
  cornerTimes: number[],
  clickTimes: number[],
  time: number,
  speed: number = ROUTE_SPEED,
): number {
  const corridor = walkTurns(cornerTimes, time, speed);
  const line = walkTurns(clickTimes, time, speed);
  const corridorPos = positionAtTime(corridor, time);
  const linePos = positionAtTime(line, time);
  const heading = headingAt(corridor, time);
  const lateral = rotate(heading, true); // perpendicular to the corridor's own heading
  return (linePos.x - corridorPos.x) * lateral.x + (linePos.y - corridorPos.y) * lateral.y;
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
