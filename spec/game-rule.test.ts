import { describe, expect, it } from "vitest";
import { runRoute, resolveCorner, CORNER_TOLERANCE_SECONDS } from "../src/scripts/track";

// The C5 spec's required "one rule under a focused automated test": whether
// the player turned in time at each corner of the generated route. This is
// the whole game — miss a corner and the run ends, so a wrong move being
// possible (the spec's "losable" requirement) and this rule are the same
// fact, tested directly.

describe("resolveCorner", () => {
  it("counts a click exactly on the corner", () => {
    expect(resolveCorner(5, 5)).toBe(true);
  });

  it("counts a click within tolerance", () => {
    expect(resolveCorner(5, 5 + CORNER_TOLERANCE_SECONDS)).toBe(true);
    expect(resolveCorner(5, 5 - CORNER_TOLERANCE_SECONDS)).toBe(true);
  });

  it("rejects a click outside tolerance", () => {
    expect(resolveCorner(5, 5 + CORNER_TOLERANCE_SECONDS + 0.01)).toBe(false);
    expect(resolveCorner(5, 5 - CORNER_TOLERANCE_SECONDS - 0.01)).toBe(false);
  });

  it("rejects no click at all", () => {
    expect(resolveCorner(5, undefined)).toBe(false);
  });
});

describe("runRoute", () => {
  it("finishes when every corner is turned in time", () => {
    const corners = [1, 2.5, 4];
    expect(runRoute(corners, corners)).toEqual({ state: "finished" });
  });

  it("finishes when clicks land anywhere inside each corner's tolerance", () => {
    const corners = [1, 2.5, 4];
    const clicks = corners.map((t) => t + CORNER_TOLERANCE_SECONDS / 2);
    expect(runRoute(corners, clicks)).toEqual({ state: "finished" });
  });

  it("dies at the first corner with no click for it", () => {
    const corners = [1, 2.5, 4];
    // click for corner 0 only
    const result = runRoute(corners, [1]);
    expect(result).toEqual({ state: "dead", failedAt: 1 });
  });

  it("dies at a corner the player clicked too late for", () => {
    const corners = [1, 2.5, 4];
    const result = runRoute(corners, [1, 2.5 + CORNER_TOLERANCE_SECONDS + 0.5, 4]);
    expect(result).toEqual({ state: "dead", failedAt: 1 });
  });

  it("dies on a stray click well before the next corner", () => {
    // player clicks early, off the straight stretch before corner 0 is due
    const corners = [5, 6];
    const result = runRoute(corners, [1]);
    expect(result).toEqual({ state: "dead", failedAt: 0 });
  });

  it("a wrong move is always possible: any single missed corner ends the run", () => {
    const corners = [1, 2, 3, 4, 5];
    for (let i = 0; i < corners.length; i++) {
      const clicks = corners.filter((_, index) => index !== i);
      expect(runRoute(corners, clicks).state).toBe("dead");
    }
  });

  it("an empty route finishes trivially", () => {
    expect(runRoute([], [])).toEqual({ state: "finished" });
  });
});
