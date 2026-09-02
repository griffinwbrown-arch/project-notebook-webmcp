import { PAGE_HEIGHT, PAGE_WIDTH, type PageRect } from "./domain";

export type PagePoint = Readonly<{ x: number; y: number }>;
export type AnnotationPath = readonly PagePoint[];
export type AnnotationBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type AnnotationGeometryInput = Readonly<{
  target: PageRect;
  seed: string;
  pageBounds?: AnnotationBounds;
}>;
export type AnnotationGeometry = Readonly<{
  path: AnnotationPath;
  frame: PageRect;
}>;
export type ConnectedArrowGeometryInput = Readonly<{
  source: PageRect;
  target: PageRect;
  seed: string;
  pageBounds?: AnnotationBounds;
}>;

const DEFAULT_BOUNDS: AnnotationBounds = {
  x: 0,
  y: 0,
  width: PAGE_WIDTH,
  height: PAGE_HEIGHT,
};

type Random = () => number;

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed: string): Random {
  let state = hashSeed(seed) || 1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

function safeBounds(bounds: AnnotationBounds): AnnotationBounds {
  return {
    x: Number.isFinite(bounds.x) ? bounds.x : 0,
    y: Number.isFinite(bounds.y) ? bounds.y : 0,
    width: Number.isFinite(bounds.width) && bounds.width > 0 ? bounds.width : PAGE_WIDTH,
    height: Number.isFinite(bounds.height) && bounds.height > 0 ? bounds.height : PAGE_HEIGHT,
  };
}

function safeTarget(target: PageRect, bounds: AnnotationBounds): PageRect {
  const width = Math.min(Number.isFinite(target.width) && target.width > 0 ? target.width : 1, bounds.width);
  const height = Math.min(Number.isFinite(target.height) && target.height > 0 ? target.height : 1, bounds.height);
  return {
    x: clamp(Number.isFinite(target.x) ? target.x : bounds.x, bounds.x, bounds.x + bounds.width - width),
    y: clamp(Number.isFinite(target.y) ? target.y : bounds.y, bounds.y, bounds.y + bounds.height - height),
    width,
    height,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function point(x: number, y: number, bounds: AnnotationBounds): PagePoint {
  return {
    x: clamp(x, bounds.x, bounds.x + bounds.width),
    y: clamp(y, bounds.y, bounds.y + bounds.height),
  };
}

function noise(random: Random, amount: number): number {
  return (random() * 2 - 1) * amount;
}

function geometryFrame(path: AnnotationPath, bounds: AnnotationBounds): PageRect {
  const xs = path.map((item) => item.x);
  const ys = path.map((item) => item.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.min(bounds.x + bounds.width - left, right - left)),
    height: Math.max(1, Math.min(bounds.y + bounds.height - top, bottom - top)),
  };
}

function resolvedInput(
  target: PageRect,
  seed: string,
  pageBounds?: AnnotationBounds,
): Readonly<{ target: PageRect; bounds: AnnotationBounds; random: Random }> {
  const bounds = safeBounds(pageBounds ?? DEFAULT_BOUNDS);
  return { target: safeTarget(target, bounds), bounds, random: seeded(seed) };
}

export function circlePath(
  target: PageRect,
  seed: string,
  pageBounds?: AnnotationBounds,
): AnnotationPath {
  const input = resolvedInput(target, seed, pageBounds);
  const { target: rect, bounds, random } = input;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const radiusX = rect.width / 2 + Math.min(10, Math.max(4, rect.width * 0.06));
  const radiusY = rect.height / 2 + Math.min(8, Math.max(4, rect.height * 0.18));
  const points: PagePoint[] = [];
  const count = 24;
  for (let index = 0; index <= count; index += 1) {
    const angle = (Math.PI * 2 * index) / count;
    const radialNoise = 1 + noise(random, 0.045);
    points.push(point(
      centerX + Math.cos(angle) * radiusX * radialNoise,
      centerY + Math.sin(angle) * radiusY * radialNoise,
      bounds,
    ));
  }
  return points;
}

export function underlinePath(
  target: PageRect,
  seed: string,
  pageBounds?: AnnotationBounds,
): AnnotationPath {
  const input = resolvedInput(target, seed, pageBounds);
  const { target: rect, bounds, random } = input;
  const baseline = rect.y + rect.height + Math.min(5, Math.max(2, rect.height * 0.08));
  const points: PagePoint[] = [];
  const count = 8;
  for (let index = 0; index <= count; index += 1) {
    const progress = index / count;
    points.push(point(
      rect.x + rect.width * progress,
      baseline + noise(random, Math.max(1.2, rect.height * 0.06)),
      bounds,
    ));
  }
  return points;
}

export function highlightPath(
  target: PageRect,
  seed: string,
  pageBounds?: AnnotationBounds,
): AnnotationPath {
  const input = resolvedInput(target, seed, pageBounds);
  const { target: rect, bounds, random } = input;
  const padX = Math.min(7, Math.max(2, rect.width * 0.025));
  const padY = Math.min(4, Math.max(2, rect.height * 0.08));
  const left = rect.x - padX;
  const right = rect.x + rect.width + padX;
  const top = rect.y - padY;
  const bottom = rect.y + rect.height + padY;
  const points: PagePoint[] = [
    point(left, top + noise(random, 1.2), bounds),
    point(right, top + noise(random, 1.2), bounds),
    point(right, bottom + noise(random, 1.2), bounds),
    point(left, bottom + noise(random, 1.2), bounds),
    point(left, top + noise(random, 1.2), bounds),
  ];
  return points;
}

export function arrowPath(
  target: PageRect,
  seed: string,
  pageBounds?: AnnotationBounds,
): AnnotationPath {
  const input = resolvedInput(target, seed, pageBounds);
  const { target: rect, bounds, random } = input;
  const targetX = rect.x + rect.width / 2;
  const targetY = rect.y + rect.height / 2;
  const tailX = rect.x + rect.width + Math.min(96, Math.max(28, rect.width * 0.7));
  const tailY = rect.y + rect.height + Math.min(54, Math.max(20, rect.height * 1.4));
  const start = point(
    tailX + noise(random, 4),
    tailY + noise(random, 4),
    bounds,
  );
  const end = point(targetX, targetY, bounds);
  const bend = point(
    (start.x + end.x) / 2 + noise(random, 8),
    (start.y + end.y) / 2 + noise(random, 8),
    bounds,
  );
  const angle = Math.atan2(end.y - bend.y, end.x - bend.x);
  const headLength = Math.min(14, Math.max(7, rect.height * 0.4));
  const wingA = point(
    end.x - Math.cos(angle - 0.55) * headLength,
    end.y - Math.sin(angle - 0.55) * headLength,
    bounds,
  );
  const wingB = point(
    end.x - Math.cos(angle + 0.55) * headLength,
    end.y - Math.sin(angle + 0.55) * headLength,
    bounds,
  );
  return [start, bend, end, wingA, end, wingB];
}

function edgePoint(rect: PageRect, toward: PagePoint, bounds: AnnotationBounds): PagePoint {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const deltaX = toward.x - centerX;
  const deltaY = toward.y - centerY;
  const horizontal = Math.abs(deltaX) / Math.max(1, rect.width / 2);
  const vertical = Math.abs(deltaY) / Math.max(1, rect.height / 2);
  const scale = 1 / Math.max(1, horizontal, vertical);
  return point(centerX + deltaX * scale, centerY + deltaY * scale, bounds);
}

export function connectedArrowGeometry(input: ConnectedArrowGeometryInput): AnnotationGeometry {
  const bounds = safeBounds(input.pageBounds ?? DEFAULT_BOUNDS);
  const random = seeded(input.seed);
  const source = safeTarget(input.source, bounds);
  const target = safeTarget(input.target, bounds);
  const sourceCenter = point(source.x + source.width / 2, source.y + source.height / 2, bounds);
  const targetCenter = point(target.x + target.width / 2, target.y + target.height / 2, bounds);
  const start = edgePoint(source, targetCenter, bounds);
  const end = edgePoint(target, sourceCenter, bounds);
  const bend = point(
    (start.x + end.x) / 2 + noise(random, 5),
    (start.y + end.y) / 2 + noise(random, 5),
    bounds,
  );
  const angle = Math.atan2(end.y - bend.y, end.x - bend.x);
  const headLength = 10;
  const wingA = point(
    end.x - Math.cos(angle - 0.55) * headLength,
    end.y - Math.sin(angle - 0.55) * headLength,
    bounds,
  );
  const wingB = point(
    end.x - Math.cos(angle + 0.55) * headLength,
    end.y - Math.sin(angle + 0.55) * headLength,
    bounds,
  );
  const path = [start, bend, end, wingA, end, wingB];
  return { path, frame: geometryFrame(path, bounds) };
}

export function labelPath(
  target: PageRect,
  seed: string,
  pageBounds?: AnnotationBounds,
): AnnotationPath {
  const input = resolvedInput(target, seed, pageBounds);
  const { target: rect, bounds, random } = input;
  const labelWidth = Math.min(160, Math.max(64, bounds.width * 0.2));
  const labelHeight = Math.min(40, Math.max(24, bounds.height * 0.04));
  const gap = 12;
  const choices: PageRect[] = [
    { x: rect.x + rect.width + gap, y: rect.y, width: labelWidth, height: labelHeight },
    { x: rect.x, y: rect.y + rect.height + gap, width: labelWidth, height: labelHeight },
    { x: rect.x - labelWidth - gap, y: rect.y, width: labelWidth, height: labelHeight },
    { x: rect.x, y: rect.y - labelHeight - gap, width: labelWidth, height: labelHeight },
  ];
  const validChoices = choices.filter((choice) =>
    choice.x >= bounds.x && choice.y >= bounds.y &&
    choice.x + choice.width <= bounds.x + bounds.width &&
    choice.y + choice.height <= bounds.y + bounds.height,
  );
  const fallback = choices[0]!;
  const label = validChoices[Math.floor(random() * Math.max(1, validChoices.length))] ?? fallback;
  const start = point(rect.x + rect.width / 2, rect.y + rect.height / 2, bounds);
  const end = point(label.x + label.width / 2, label.y + label.height / 2, bounds);
  const bend = point(
    (start.x + end.x) / 2 + noise(random, 4),
    (start.y + end.y) / 2 + noise(random, 4),
    bounds,
  );
  return [start, bend, end];
}

export function circleGeometry(input: AnnotationGeometryInput): AnnotationGeometry {
  const bounds = safeBounds(input.pageBounds ?? DEFAULT_BOUNDS);
  const path = circlePath(input.target, input.seed, bounds);
  return { path, frame: geometryFrame(path, bounds) };
}

export function underlineGeometry(input: AnnotationGeometryInput): AnnotationGeometry {
  const bounds = safeBounds(input.pageBounds ?? DEFAULT_BOUNDS);
  const path = underlinePath(input.target, input.seed, bounds);
  return { path, frame: geometryFrame(path, bounds) };
}

export function highlightGeometry(input: AnnotationGeometryInput): AnnotationGeometry {
  const bounds = safeBounds(input.pageBounds ?? DEFAULT_BOUNDS);
  const path = highlightPath(input.target, input.seed, bounds);
  return { path, frame: geometryFrame(path, bounds) };
}

export function arrowGeometry(input: AnnotationGeometryInput): AnnotationGeometry {
  const bounds = safeBounds(input.pageBounds ?? DEFAULT_BOUNDS);
  const path = arrowPath(input.target, input.seed, bounds);
  return { path, frame: geometryFrame(path, bounds) };
}

export function labelGeometry(input: AnnotationGeometryInput): AnnotationGeometry {
  const bounds = safeBounds(input.pageBounds ?? DEFAULT_BOUNDS);
  const path = labelPath(input.target, input.seed, bounds);
  return { path, frame: geometryFrame(path, bounds) };
}

export const circleAnnotationPath = circlePath;
export const underlineAnnotationPath = underlinePath;
export const highlightAnnotationPath = highlightPath;
export const arrowAnnotationPath = arrowPath;
export const labelAnnotationPath = labelPath;
