import { describe, expect, it } from "vitest";
import { buildRouteShape, positionAtTime, headingAt, walkTurns, ROUTE_SPEED } from "./route";
import type { Beat } from "./rhythm";

// Engineering confidence for the "turn timestamps -> drawable shape" step —
// not the spec's required test (that's spec/game-rule.test.ts). Mirrors
// rhythm.test.ts's synthetic-data approach.

function beat(time: number, isTurn: boolean, strength = 5): Beat {
  return { time, strength, isTurn };
}

describe("buildRouteShape", () => {
  it("produces a straight tail with no turns at all", () => {
    const shape = buildRouteShape([beat(1, false), beat(2, false)], { maxDurationSeconds: 10 });
    expect(shape.turnTimes).toEqual([]);
    expect(shape.points).toHaveLength(2); // start + tail end
    expect(shape.duration).toBe(10);
    expect(shape.decorations).toHaveLength(2);
  });

  it("turns 90 degrees at each turn beat", () => {
    const shape = buildRouteShape([beat(1, true), beat(2, true), beat(3, true)], { maxDurationSeconds: 4 });
    expect(shape.turnTimes).toEqual([1, 2, 3]);
    // 5 vertices: start, 3 turns, final tail.
    expect(shape.points).toHaveLength(5);
    for (let i = 1; i < shape.points.length - 1; i++) {
      const inbound = { x: shape.points[i].x - shape.points[i - 1].x, y: shape.points[i].y - shape.points[i - 1].y };
      const outbound = { x: shape.points[i + 1].x - shape.points[i].x, y: shape.points[i + 1].y - shape.points[i].y };
      const dot = inbound.x * outbound.x + inbound.y * outbound.y;
      expect(dot).toBeCloseTo(0);
    }
  });

  it("segment length matches elapsed time times speed", () => {
    const shape = buildRouteShape([beat(2, true)], { maxDurationSeconds: 2 });
    const [start, turn] = shape.points;
    const length = Math.hypot(turn.x - start.x, turn.y - start.y);
    expect(length).toBeCloseTo(2 * ROUTE_SPEED);
  });

  it("clips turns, decorations, and duration to maxDurationSeconds", () => {
    const shape = buildRouteShape([beat(1, true), beat(5, true), beat(9, false)], { maxDurationSeconds: 6 });
    expect(shape.turnTimes).toEqual([1, 5]);
    expect(shape.decorations).toEqual([]);
    expect(shape.duration).toBe(6);
  });

  it("uses a custom speed", () => {
    const shape = buildRouteShape([beat(1, true)], { maxDurationSeconds: 1, speed: 10 });
    const [start, turn] = shape.points;
    expect(Math.hypot(turn.x - start.x, turn.y - start.y)).toBeCloseTo(10);
  });
});

describe("walkTurns", () => {
  it("produces a straight tail with no turns at all", () => {
    const points = walkTurns([], 3, 10);
    expect(points).toHaveLength(2);
    expect(points[1]).toEqual({ time: 3, x: 0, y: -30 });
  });

  it("segment length matches elapsed time times speed", () => {
    const points = walkTurns([2], 2, 10);
    const [start, turn] = points;
    expect(Math.hypot(turn.x - start.x, turn.y - start.y)).toBeCloseTo(20);
  });

  it("only applies turns up to duration, without needing pre-filtered input", () => {
    const points = walkTurns([1, 5, 9], 6, 10);
    expect(points.map((p) => p.time)).toEqual([0, 1, 5, 6]);
  });
});

describe("headingAt", () => {
  it("stays on the starting heading before the first turn", () => {
    const points = walkTurns([5], 10, 10);
    expect(headingAt(points, 2)).toEqual({ x: 0, y: -1 });
  });

  it("rotates 90 degrees after a turn", () => {
    const points = walkTurns([5], 10, 10);
    const heading = headingAt(points, 8);
    expect(heading.x).toBeCloseTo(1);
    expect(heading.y).toBeCloseTo(0);
  });
});

describe("positionAtTime", () => {
  it("returns the start point before the route begins", () => {
    const points = [{ time: 0, x: 0, y: 0 }, { time: 2, x: 0, y: -20 }];
    expect(positionAtTime(points, -1)).toEqual({ x: 0, y: 0 });
  });

  it("returns an exact vertex at its own time", () => {
    const points = [{ time: 0, x: 0, y: 0 }, { time: 2, x: 0, y: -20 }, { time: 4, x: 20, y: -20 }];
    expect(positionAtTime(points, 2)).toEqual({ x: 0, y: -20 });
  });

  it("lerps mid-segment", () => {
    const points = [{ time: 0, x: 0, y: 0 }, { time: 2, x: 0, y: -20 }];
    expect(positionAtTime(points, 1)).toEqual({ x: 0, y: -10 });
  });

  it("clamps to the last point past the route's end", () => {
    const points = [{ time: 0, x: 0, y: 0 }, { time: 2, x: 0, y: -20 }];
    expect(positionAtTime(points, 100)).toEqual({ x: 0, y: -20 });
  });

  it("decoration markers land exactly on the polyline", () => {
    const shape = buildRouteShape([beat(2, true), beat(1, false)], { maxDurationSeconds: 3 });
    const decoration = shape.decorations[0];
    expect(decoration.time).toBe(1);
    expect(decoration).toEqual({ time: 1, ...positionAtTime(shape.points, 1) });
  });
});
