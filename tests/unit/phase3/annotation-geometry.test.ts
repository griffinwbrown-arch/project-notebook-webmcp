import { describe, expect, it } from "vitest";

import {
  arrowPath,
  circlePath,
  highlightPath,
  labelPath,
  underlinePath,
} from "../../../src/page/annotation-geometry";

const bounds = { x: 0, y: 0, width: 816, height: 1056 } as const;
const target = { x: 180, y: 240, width: 180, height: 32 } as const;

function expectBounded(points: readonly Readonly<{ x: number; y: number }>[]): void {
  expect(points.length).toBeGreaterThan(1);
  expect(points.every((point) => point.x >= bounds.x && point.y >= bounds.y)).toBe(true);
  expect(points.every((point) => point.x <= bounds.width && point.y <= bounds.height)).toBe(true);
}

describe("seeded annotation geometry", () => {
  it("produces deterministic rough paths for every annotation kind", () => {
    const paths = [
      [circlePath(target, "annotation-1", bounds), circlePath(target, "annotation-1", bounds)],
      [underlinePath(target, "annotation-1", bounds), underlinePath(target, "annotation-1", bounds)],
      [highlightPath(target, "annotation-1", bounds), highlightPath(target, "annotation-1", bounds)],
      [arrowPath(target, "annotation-1", bounds), arrowPath(target, "annotation-1", bounds)],
      [labelPath(target, "annotation-1", bounds), labelPath(target, "annotation-1", bounds)],
    ];

    for (const pair of paths) {
      const first = pair[0];
      const second = pair[1];
      if (first === undefined || second === undefined) throw new Error("A geometry pair must contain two paths.");
      expect(first).toEqual(second);
      expectBounded(first);
    }
  });

  it("changes the roughness slightly when the annotation identity changes", () => {
    const first = circlePath(target, "annotation-1", bounds);
    const second = circlePath(target, "annotation-2", bounds);

    expect(second).not.toEqual(first);
    expectBounded(first);
    expectBounded(second);
  });

  it("clamps expanded marks to finite page bounds", () => {
    const edgeTarget = { x: -40, y: -20, width: 900, height: 1200 } as const;

    for (const path of [
      circlePath(edgeTarget, "edge", bounds),
      underlinePath(edgeTarget, "edge", bounds),
      highlightPath(edgeTarget, "edge", bounds),
      arrowPath(edgeTarget, "edge", bounds),
      labelPath(edgeTarget, "edge", bounds),
    ]) {
      expectBounded(path);
    }
  });
});
