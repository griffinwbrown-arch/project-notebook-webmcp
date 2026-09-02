import { describe, expect, it } from "vitest";

import {
  arrowAnnotationPath,
  arrowGeometry,
  arrowPath,
  circleAnnotationPath,
  circleGeometry,
  circlePath,
  connectedArrowGeometry,
  highlightAnnotationPath,
  highlightGeometry,
  highlightPath,
  labelAnnotationPath,
  labelGeometry,
  labelPath,
  underlineAnnotationPath,
  underlineGeometry,
  underlinePath,
  type AnnotationGeometry,
  type AnnotationPath,
} from "../../../src/page/annotation-geometry";

const bounds = { x: 0, y: 0, width: 816, height: 1056 } as const;
const target = { x: 180, y: 240, width: 180, height: 32 } as const;
type BoundaryBounds = typeof bounds;
type BoundaryTarget = typeof target;

function frameFor(path: AnnotationPath): Readonly<{ x: number; y: number; width: number; height: number }> {
  const xs = path.map(({ x }) => x);
  const ys = path.map(({ y }) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(bounds.x + bounds.width - left, Math.max(...xs) - left)),
    height: Math.max(1, Math.min(bounds.y + bounds.height - top, Math.max(...ys) - top)),
  };
}

function expectBounded(path: AnnotationPath): void {
  expect(path.length).toBeGreaterThan(1);
  expect(path.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  expect(path.every(({ x, y }) => x >= bounds.x && x <= bounds.width && y >= bounds.y && y <= bounds.height)).toBe(true);
}

describe("annotation geometry wrappers and finite boundaries", () => {
  it("normalizes nonfinite and zero bounds to the default page bounds", () => {
    const malformedBounds = {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: 0,
      height: -1,
    };

    for (const geometry of [circleGeometry, underlineGeometry, highlightGeometry, arrowGeometry, labelGeometry]) {
      const normalized = geometry({ target, seed: "safe-bounds", pageBounds: malformedBounds });
      const defaults = geometry({ target, seed: "safe-bounds" });
      expect(normalized).toEqual(defaults);
      expectBounded(normalized.path);
      expect(normalized.frame).toEqual(frameFor(normalized.path));
    }
  });

  it("normalizes nonfinite and zero target dimensions before generating paths", () => {
    const malformedTarget = {
      x: Number.NaN,
      y: Number.POSITIVE_INFINITY,
      width: 0,
      height: -3,
    };
    const normalizedTarget = { x: 0, y: 0, width: 1, height: 1 } as const;

    expect(underlinePath(malformedTarget, "safe-target", bounds)).toEqual(
      underlinePath(normalizedTarget, "safe-target", bounds),
    );
    expectBounded(underlinePath(malformedTarget, "safe-target", bounds));
  });

  it("keeps every public geometry wrapper aligned with its path and alias", () => {
    const cases: readonly {
      readonly geometry: (input: { target: BoundaryTarget; seed: string; pageBounds: BoundaryBounds }) => AnnotationGeometry;
      readonly path: (inputTarget: BoundaryTarget, seed: string, inputBounds: BoundaryBounds) => AnnotationPath;
      readonly alias: (inputTarget: BoundaryTarget, seed: string, inputBounds: BoundaryBounds) => AnnotationPath;
    }[] = [
      { geometry: circleGeometry, path: circlePath, alias: circleAnnotationPath },
      { geometry: underlineGeometry, path: underlinePath, alias: underlineAnnotationPath },
      { geometry: highlightGeometry, path: highlightPath, alias: highlightAnnotationPath },
      { geometry: arrowGeometry, path: arrowPath, alias: arrowAnnotationPath },
      { geometry: labelGeometry, path: labelPath, alias: labelAnnotationPath },
    ];

    for (const entry of cases) {
      const geometry = entry.geometry({ target, seed: "wrapper-alignment", pageBounds: bounds });
      expect(geometry.path).toEqual(entry.path(target, "wrapper-alignment", bounds));
      expect(entry.alias(target, "wrapper-alignment", bounds)).toEqual(geometry.path);
      expect(geometry.frame).toEqual(frameFor(geometry.path));
      expectBounded(geometry.path);
    }
  });

  it("connects separated rectangles at their exact facing edges", () => {
    const geometry = connectedArrowGeometry({
      source: { x: 100, y: 100, width: 100, height: 50 },
      target: { x: 400, y: 100, width: 100, height: 50 },
      seed: "edge-arrow",
      pageBounds: bounds,
    });

    expect(geometry.path[0]).toEqual({ x: 200, y: 125 });
    expect(geometry.path[2]).toEqual({ x: 400, y: 125 });
    expect(geometry.frame.x).toBe(200);
    expect(geometry.frame.width).toBe(200);
    expectBounded(geometry.path);
  });
});
