import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import { MAX_SURFACE_PAINT_ANCHORS_PER_STROKE } from "../../src/anatomy";
import {
  createAtlasNotebook,
  executeTool,
  expectNoBrowserErrors,
  installAnatomyAcceptanceBridge,
  observeBrowser,
  percentile,
  requiredNumber,
  requiredRecord,
  requiredString,
  waitForTools,
  writeEvidence,
} from "./anatomy-atlas-helpers";

test.skip(process.env.ANATOMY_ACCEPTANCE_RUN !== "1", "Run through test:anatomy:acceptance with the pinned external atlas.");

const TEST_TITLE = "@desktop keeps 3D brush strokes local, continuous, anchored, persistent, and undoable";
const CHANGE_THRESHOLD = 20;
const MIN_LOCAL_COVERAGE = 0.005;
const MAX_LOCAL_COVERAGE = 0.30;
const MIN_UNCHANGED_COVERAGE = 0.65;
// The supplied atlas uses coarse triangles in parts of the frontal bone. The intentionally
// smaller surface brush can tint an incident triangle beyond its narrow sample capsule,
// while the 30% same-bone cap and continuity checks still reject whole-bone fills.
const MAX_BRUSH_TRIANGLE_SPILL_RATIO = 0.35;
const MAX_OUTSIDE_SILHOUETTE_RATIO = 0.05;
const MIN_PROBE_COVERAGE = 9;
const MIN_CONNECTED_CHANGE_RATIO = 0.75;
const MIN_PATH_SPAN_RATIO = 0.85;
const MIN_ERASE_CENTER_RESTORE_RATIO = 0.60;
const MIN_ERASE_END_RETAIN_RATIO = 0.80;
const MAX_ERASE_OFF_PATH_INTERIOR_RATIO = 0.005;
const MIN_UNDO_MASK_IOU = 0.98;
const MIN_RELOAD_MASK_IOU = 0.97;
const MAX_REPLAY_MEAN_RGB_ERROR = 2;
const MAX_PREVIEW_LATENCY_MS = 50;
const MAX_PERSIST_LATENCY_MS = 300;
const MAX_PAINT_RAF_P95_MS = 34;
const MAX_PAINT_RAF_MS = 100;
const MAX_SETTLED_DRAW_CALLS = 4;

type RasterPoint = Readonly<{ x: number; y: number }>;
type StrokePlan = Readonly<{
  imageWidth: number;
  imageHeight: number;
  foregroundPixels: number;
  interiorPixels: number;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
  path: readonly RasterPoint[];
  probes: readonly RasterPoint[];
  capsuleRadius: number;
}>;

type PaintMetrics = Readonly<{
  local: Readonly<{
    changedPixels: number;
    interiorPixels: number;
    changedRatio: number;
    unchangedRatio: number;
    offPathChangedPixels: number;
    offPathChangeRatio: number;
    coveredProbes: number;
    probeCount: number;
    largestConnectedPixels: number;
    largestConnectedRatio: number;
    pathSpanRatio: number;
  }>;
  erase: Readonly<{
    centerPaintPixels: number;
    centerRestoredPixels: number;
    centerRestoreRatio: number;
    endPaintPixels: number;
    endRetainedPixels: number;
    endRetainRatio: number;
    changedOutsideCapsulePixels: number;
    changedOutsideCapsuleInteriorRatio: number;
  }>;
  anchoring: Readonly<{
    leftChangedPixels: number;
    leftOutsideSilhouettePixels: number;
    leftOutsideSilhouetteRatio: number;
    centroidDisplacementPixels: number;
    returnedAnteriorMaskIou: number;
  }>;
  undo: Readonly<{
    maskIou: number;
    meanRgbError: number;
  }>;
  reload: Readonly<{
    maskIou: number;
    meanRgbError: number;
  }>;
  maskPngBase64: string;
}>;

type SurfaceRead = Readonly<{
  colored: number;
  surfaceStrokeCount: number;
  surfaceAnchorCount: number;
  surfaceStateFingerprint: string;
  raw: Readonly<Record<string, unknown>>;
}>;

async function waitForExactCanvas(canvas: Locator): Promise<void> {
  await expect(canvas).toHaveAttribute("data-atlas-ready", "true", { timeout: 30_000 });
  let previousCameraSignature = "";
  let stableSamples = 0;
  await expect.poll(async () => {
    const sample = await canvas.evaluate((element) => ({
      exactState: element.dataset.atlasExactCompositionState ?? "missing",
      cameraSignature: [
        element.dataset.cameraView ?? "missing",
        element.dataset.cameraPosition ?? "missing",
        element.dataset.cameraDistance ?? "missing",
      ].join("|"),
    }));
    if (sample.exactState !== "settled" || sample.cameraSignature.includes("missing")) {
      previousCameraSignature = sample.cameraSignature;
      stableSamples = 0;
      return stableSamples;
    }
    stableSamples = sample.cameraSignature === previousCameraSignature ? stableSamples + 1 : 0;
    previousCameraSignature = sample.cameraSignature;
    return stableSamples;
  }, {
    message: "The isolated anatomy camera and exact presentation did not settle.",
    timeout: 10_000,
    intervals: [60],
  }).toBeGreaterThanOrEqual(3);
  await canvas.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function captureCanvas(page: Page, canvas: Locator, path: string): Promise<Buffer> {
  await page.mouse.move(2, 2);
  await waitForExactCanvas(canvas);
  const maskId = `surface-paint-capture-mask-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await canvas.evaluate((element, id) => {
    const style = element.ownerDocument.createElement("style");
    style.id = id;
    style.textContent = [
      ".anatomy-model-stage > :not(.anatomy-model-canvas) { visibility: hidden !important; }",
      ".anatomy-model-stage::after { display: none !important; }",
      ".page-controls { visibility: hidden !important; }",
    ].join("\n");
    element.ownerDocument.head.append(style);
  }, maskId);
  try {
    return await canvas.screenshot({ path, animations: "disabled" });
  } finally {
    await canvas.evaluate((element, id) => element.ownerDocument.getElementById(id)?.remove(), maskId);
  }
}

async function deriveStrokePlan(page: Page, png: Buffer): Promise<StrokePlan> {
  return page.evaluate(async (base64): Promise<StrokePlan> => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const scratch = document.createElement("canvas");
    scratch.width = bitmap.width;
    scratch.height = bitmap.height;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    if (context === null) throw new Error("Chromium did not provide a 2D image context for the surface-paint gate.");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, scratch.width, scratch.height).data;
    const foreground = new Uint8Array(scratch.width * scratch.height);
    let foregroundPixels = 0;
    let left = scratch.width;
    let right = -1;
    let top = scratch.height;
    let bottom = -1;
    for (let y = 4; y < scratch.height - 4; y += 1) {
      for (let x = 4; x < scratch.width - 4; x += 1) {
        const pixelIndex = y * scratch.width + x;
        const offset = pixelIndex * 4;
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
        if (luminance < 110) continue;
        foreground[pixelIndex] = 1;
        foregroundPixels += 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    if (right < left || bottom < top) throw new Error("The isolated bone screenshot had no measurable foreground.");

    const erosionRadius = 4;
    const interior = new Uint8Array(foreground.length);
    let interiorPixels = 0;
    for (let y = top + erosionRadius; y <= bottom - erosionRadius; y += 1) {
      for (let x = left + erosionRadius; x <= right - erosionRadius; x += 1) {
        const pixelIndex = y * scratch.width + x;
        if (foreground[pixelIndex] === 0) continue;
        let survives = true;
        for (let offsetY = -erosionRadius; offsetY <= erosionRadius && survives; offsetY += 1) {
          for (let offsetX = -erosionRadius; offsetX <= erosionRadius; offsetX += 1) {
            if (offsetX * offsetX + offsetY * offsetY > erosionRadius * erosionRadius) continue;
            if (foreground[(y + offsetY) * scratch.width + x + offsetX] === 0) {
              survives = false;
              break;
            }
          }
        }
        if (!survives) continue;
        interior[pixelIndex] = 1;
        interiorPixels += 1;
      }
    }
    if (interiorPixels < 1_000) throw new Error(`The isolated bone exposed only ${interiorPixels} eroded interior pixels.`);

    let best = { y: -1, start: -1, end: -1, length: 0 };
    const scanTop = Math.round(top + (bottom - top) * 0.22);
    const scanBottom = Math.round(top + (bottom - top) * 0.72);
    for (let y = scanTop; y <= scanBottom; y += 1) {
      let start = -1;
      for (let x = left; x <= right + 1; x += 1) {
        const inside = x <= right && interior[y * scratch.width + x] === 1;
        if (inside && start < 0) start = x;
        if (inside || start < 0) continue;
        const length = x - start;
        if (length > best.length) best = { y, start, end: x - 1, length };
        start = -1;
      }
    }
    if (best.length < 64) throw new Error(`The isolated bone's longest safe brush lane was only ${best.length}px.`);
    const inset = Math.max(10, Math.round(best.length * 0.18));
    const pathStart = best.start + inset;
    const pathEnd = best.end - inset;
    const pathLength = pathEnd - pathStart;
    if (pathLength < 40) throw new Error(`The safe brush path was only ${pathLength}px after edge protection.`);
    const path = Array.from({ length: 96 }, (_, index) => ({
      x: pathStart + pathLength * index / 95,
      y: best.y,
    }));
    const probes = Array.from({ length: 9 }, (_, index) => ({
      x: pathStart + pathLength * index / 8,
      y: best.y,
    }));
    return {
      imageWidth: scratch.width,
      imageHeight: scratch.height,
      foregroundPixels,
      interiorPixels,
      bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
      path,
      probes,
      capsuleRadius: Math.max(18, Math.min(30, pathLength * 0.10)),
    };
  }, png.toString("base64"));
}

async function analyzePaintRasters(page: Page, input: Readonly<{
  plan: StrokePlan;
  baseline: Buffer;
  leftBaseline: Buffer;
  painted: Buffer;
  paintedLeft: Buffer;
  returnedAnterior: Buffer;
  erased: Buffer;
  undo: Buffer;
  reload: Buffer;
}>): Promise<PaintMetrics> {
  const rasters = Object.fromEntries(Object.entries(input)
    .filter((entry): entry is [string, Buffer] => Buffer.isBuffer(entry[1]))
    .map(([key, value]) => [key, value.toString("base64")]));
  return page.evaluate(async ({ encoded, plan, threshold }): Promise<PaintMetrics> => {
    type Decoded = Readonly<{ width: number; height: number; pixels: Uint8ClampedArray }>;
    const decode = async (base64: string): Promise<Decoded> => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const scratch = document.createElement("canvas");
      scratch.width = bitmap.width;
      scratch.height = bitmap.height;
      const context = scratch.getContext("2d", { willReadFrequently: true });
      if (context === null) throw new Error("Chromium did not provide a 2D image context for paint analysis.");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { width: scratch.width, height: scratch.height, pixels: context.getImageData(0, 0, scratch.width, scratch.height).data };
    };
    const requiredEncoded = (key: string): string => {
      const value = encoded[key];
      if (typeof value !== "string") throw new Error(`Missing ${key} raster.`);
      return value;
    };
    const [baseline, leftBaseline, painted, paintedLeft, returnedAnterior, erased, undo, reload] = await Promise.all([
      decode(requiredEncoded("baseline")),
      decode(requiredEncoded("leftBaseline")),
      decode(requiredEncoded("painted")),
      decode(requiredEncoded("paintedLeft")),
      decode(requiredEncoded("returnedAnterior")),
      decode(requiredEncoded("erased")),
      decode(requiredEncoded("undo")),
      decode(requiredEncoded("reload")),
    ]);
    const sameDimensions = [painted, returnedAnterior, erased, undo, reload]
      .every((image) => image.width === baseline.width && image.height === baseline.height);
    if (!sameDimensions) throw new Error("Anterior paint evidence changed dimensions between captures.");
    if (paintedLeft.width !== leftBaseline.width || paintedLeft.height !== leftBaseline.height) {
      throw new Error("Left-view paint evidence changed dimensions between captures.");
    }
    if (baseline.width !== plan.imageWidth || baseline.height !== plan.imageHeight) {
      throw new Error("The stroke plan does not match its baseline raster.");
    }

    const foregroundMask = (image: Decoded): Uint8Array => {
      const result = new Uint8Array(image.width * image.height);
      for (let index = 0; index < result.length; index += 1) {
        const offset = index * 4;
        const red = image.pixels[offset] ?? 0;
        const green = image.pixels[offset + 1] ?? 0;
        const blue = image.pixels[offset + 2] ?? 0;
        if (red * 0.2126 + green * 0.7152 + blue * 0.0722 >= 110) result[index] = 1;
      }
      return result;
    };
    const erode = (source: Uint8Array, width: number, height: number, radius: number): Uint8Array => {
      const result = new Uint8Array(source.length);
      for (let y = radius; y < height - radius; y += 1) {
        for (let x = radius; x < width - radius; x += 1) {
          const index = y * width + x;
          if (source[index] === 0) continue;
          let survives = true;
          for (let offsetY = -radius; offsetY <= radius && survives; offsetY += 1) {
            for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
              if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue;
              if (source[(y + offsetY) * width + x + offsetX] === 0) {
                survives = false;
                break;
              }
            }
          }
          if (survives) result[index] = 1;
        }
      }
      return result;
    };
    const dilate = (source: Uint8Array, width: number, height: number, radius: number): Uint8Array => {
      const result = new Uint8Array(source.length);
      for (let y = radius; y < height - radius; y += 1) {
        for (let x = radius; x < width - radius; x += 1) {
          let found = false;
          for (let offsetY = -radius; offsetY <= radius && !found; offsetY += 1) {
            for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
              if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue;
              if (source[(y + offsetY) * width + x + offsetX] === 1) {
                found = true;
                break;
              }
            }
          }
          if (found) result[y * width + x] = 1;
        }
      }
      return result;
    };
    const rgbDistance = (leftImage: Decoded, rightImage: Decoded, index: number): number => {
      const offset = index * 4;
      const red = (leftImage.pixels[offset] ?? 0) - (rightImage.pixels[offset] ?? 0);
      const green = (leftImage.pixels[offset + 1] ?? 0) - (rightImage.pixels[offset + 1] ?? 0);
      const blue = (leftImage.pixels[offset + 2] ?? 0) - (rightImage.pixels[offset + 2] ?? 0);
      return Math.hypot(red, green, blue);
    };
    const changedMask = (leftImage: Decoded, rightImage: Decoded, allowed?: Uint8Array): Uint8Array => {
      const result = new Uint8Array(leftImage.width * leftImage.height);
      for (let index = 0; index < result.length; index += 1) {
        if (allowed !== undefined && allowed[index] === 0) continue;
        if (rgbDistance(leftImage, rightImage, index) >= threshold) result[index] = 1;
      }
      return result;
    };
    const countMask = (mask: Uint8Array): number => mask.reduce((sum, value) => sum + value, 0);
    const baselineInterior = erode(foregroundMask(baseline), baseline.width, baseline.height, 4);
    const interiorPixels = countMask(baselineInterior);
    const paintedMask = changedMask(baseline, painted, baselineInterior);
    const changedPixels = countMask(paintedMask);

    const distanceToSegment = (point: RasterPoint, start: RasterPoint, end: RasterPoint): number => {
      const deltaX = end.x - start.x;
      const deltaY = end.y - start.y;
      const lengthSquared = deltaX * deltaX + deltaY * deltaY;
      if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
      const amount = Math.max(0, Math.min(1, ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared));
      return Math.hypot(point.x - (start.x + deltaX * amount), point.y - (start.y + deltaY * amount));
    };
    const pathStart = plan.path[0];
    const pathEnd = plan.path.at(-1);
    if (pathStart === undefined || pathEnd === undefined) throw new Error("The paint path is empty.");
    const inCapsule = (x: number, y: number, start: RasterPoint, end: RasterPoint, radius: number): boolean =>
      distanceToSegment({ x, y }, start, end) <= radius;
    let offPathChangedPixels = 0;
    for (let index = 0; index < paintedMask.length; index += 1) {
      if (paintedMask[index] === 0) continue;
      const x = index % baseline.width;
      const y = Math.floor(index / baseline.width);
      if (!inCapsule(x, y, pathStart, pathEnd, plan.capsuleRadius)) offPathChangedPixels += 1;
    }

    const probeRadius = Math.max(7, Math.round(plan.capsuleRadius * 0.52));
    const coveredProbes = plan.probes.filter((probe) => {
      for (let y = Math.max(0, Math.floor(probe.y - probeRadius)); y <= Math.min(baseline.height - 1, Math.ceil(probe.y + probeRadius)); y += 1) {
        for (let x = Math.max(0, Math.floor(probe.x - probeRadius)); x <= Math.min(baseline.width - 1, Math.ceil(probe.x + probeRadius)); x += 1) {
          if (Math.hypot(x - probe.x, y - probe.y) <= probeRadius && paintedMask[y * baseline.width + x] === 1) return true;
        }
      }
      return false;
    }).length;

    const visited = new Uint8Array(paintedMask.length);
    const directionX = pathEnd.x - pathStart.x;
    const directionY = pathEnd.y - pathStart.y;
    const pathLength = Math.hypot(directionX, directionY);
    const unitX = directionX / pathLength;
    const unitY = directionY / pathLength;
    let largestConnectedPixels = 0;
    let largestPathSpan = 0;
    const neighbors = [-1, 0, 1];
    for (let seed = 0; seed < paintedMask.length; seed += 1) {
      if (paintedMask[seed] === 0 || visited[seed] === 1) continue;
      const stack = [seed];
      visited[seed] = 1;
      let componentPixels = 0;
      let minProjection = Number.POSITIVE_INFINITY;
      let maxProjection = Number.NEGATIVE_INFINITY;
      while (stack.length > 0) {
        const index = stack.pop();
        if (index === undefined) break;
        componentPixels += 1;
        const x = index % baseline.width;
        const y = Math.floor(index / baseline.width);
        const projection = (x - pathStart.x) * unitX + (y - pathStart.y) * unitY;
        minProjection = Math.min(minProjection, projection);
        maxProjection = Math.max(maxProjection, projection);
        for (const offsetY of neighbors) {
          for (const offsetX of neighbors) {
            if (offsetX === 0 && offsetY === 0) continue;
            const nextX = x + offsetX;
            const nextY = y + offsetY;
            if (nextX < 0 || nextX >= baseline.width || nextY < 0 || nextY >= baseline.height) continue;
            const next = nextY * baseline.width + nextX;
            if (paintedMask[next] === 0 || visited[next] === 1) continue;
            visited[next] = 1;
            stack.push(next);
          }
        }
      }
      if (componentPixels > largestConnectedPixels) {
        largestConnectedPixels = componentPixels;
        largestPathSpan = maxProjection - minProjection;
      }
    }

    const eraserStart = plan.path[Math.floor(plan.path.length * 0.34)];
    const eraserEnd = plan.path[Math.floor(plan.path.length * 0.66)];
    if (eraserStart === undefined || eraserEnd === undefined) throw new Error("The eraser path is incomplete.");
    let centerPaintPixels = 0;
    let centerRestoredPixels = 0;
    let endPaintPixels = 0;
    let endRetainedPixels = 0;
    for (let index = 0; index < paintedMask.length; index += 1) {
      if (paintedMask[index] === 0) continue;
      const x = index % baseline.width;
      const y = Math.floor(index / baseline.width);
      const projection = ((x - pathStart.x) * unitX + (y - pathStart.y) * unitY) / pathLength;
      const baselineError = rgbDistance(painted, baseline, index);
      const erasedError = rgbDistance(erased, baseline, index);
      if (projection >= 0.34 && projection <= 0.66) {
        centerPaintPixels += 1;
        if (erasedError <= Math.max(10, baselineError * 0.40)) centerRestoredPixels += 1;
      } else if (projection <= 0.25 || projection >= 0.75) {
        endPaintPixels += 1;
        if (erasedError >= threshold) endRetainedPixels += 1;
      }
    }
    const eraseDelta = changedMask(painted, erased, baselineInterior);
    let changedOutsideCapsulePixels = 0;
    for (let index = 0; index < eraseDelta.length; index += 1) {
      if (eraseDelta[index] === 0) continue;
      const x = index % baseline.width;
      const y = Math.floor(index / baseline.width);
      if (!inCapsule(x, y, eraserStart, eraserEnd, plan.capsuleRadius)) changedOutsideCapsulePixels += 1;
    }

    const maskIou = (leftMask: Uint8Array, rightMask: Uint8Array): number => {
      let intersection = 0;
      let union = 0;
      for (let index = 0; index < leftMask.length; index += 1) {
        const leftValue = leftMask[index] === 1;
        const rightValue = rightMask[index] === 1;
        if (leftValue && rightValue) intersection += 1;
        if (leftValue || rightValue) union += 1;
      }
      return union === 0 ? 1 : intersection / union;
    };
    const meanRgbError = (leftImage: Decoded, rightImage: Decoded, allowed: Uint8Array): number => {
      let total = 0;
      let samples = 0;
      for (let index = 0; index < allowed.length; index += 1) {
        if (allowed[index] === 0) continue;
        const offset = index * 4;
        total += Math.abs((leftImage.pixels[offset] ?? 0) - (rightImage.pixels[offset] ?? 0));
        total += Math.abs((leftImage.pixels[offset + 1] ?? 0) - (rightImage.pixels[offset + 1] ?? 0));
        total += Math.abs((leftImage.pixels[offset + 2] ?? 0) - (rightImage.pixels[offset + 2] ?? 0));
        samples += 3;
      }
      return samples === 0 ? 0 : total / samples;
    };
    const undoMask = changedMask(baseline, undo, baselineInterior);
    const reloadMask = changedMask(baseline, reload, baselineInterior);
    const returnedMask = changedMask(baseline, returnedAnterior, baselineInterior);

    const leftForeground = foregroundMask(leftBaseline);
    const leftSilhouette = dilate(leftForeground, leftBaseline.width, leftBaseline.height, 4);
    const leftChanged = changedMask(leftBaseline, paintedLeft);
    let leftOutsideSilhouettePixels = 0;
    let leftChangedPixels = 0;
    let leftCentroidX = 0;
    let leftCentroidY = 0;
    for (let index = 0; index < leftChanged.length; index += 1) {
      if (leftChanged[index] === 0) continue;
      leftChangedPixels += 1;
      leftCentroidX += index % leftBaseline.width;
      leftCentroidY += Math.floor(index / leftBaseline.width);
      if (leftSilhouette[index] === 0) leftOutsideSilhouettePixels += 1;
    }
    let anteriorCentroidX = 0;
    let anteriorCentroidY = 0;
    for (let index = 0; index < paintedMask.length; index += 1) {
      if (paintedMask[index] === 0) continue;
      anteriorCentroidX += index % baseline.width;
      anteriorCentroidY += Math.floor(index / baseline.width);
    }
    anteriorCentroidX /= Math.max(1, changedPixels);
    anteriorCentroidY /= Math.max(1, changedPixels);
    leftCentroidX /= Math.max(1, leftChangedPixels);
    leftCentroidY /= Math.max(1, leftChangedPixels);

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = baseline.width;
    maskCanvas.height = baseline.height;
    const maskContext = maskCanvas.getContext("2d");
    if (maskContext === null) throw new Error("Chromium did not provide a mask visualization context.");
    const maskImage = maskContext.createImageData(maskCanvas.width, maskCanvas.height);
    for (let index = 0; index < paintedMask.length; index += 1) {
      const offset = index * 4;
      if (paintedMask[index] === 1) {
        maskImage.data[offset] = 224;
        maskImage.data[offset + 1] = 70;
        maskImage.data[offset + 2] = 78;
        maskImage.data[offset + 3] = 235;
      } else if (baselineInterior[index] === 1) {
        maskImage.data[offset] = 225;
        maskImage.data[offset + 1] = 228;
        maskImage.data[offset + 2] = 231;
        maskImage.data[offset + 3] = 85;
      }
    }
    maskContext.putImageData(maskImage, 0, 0);
    maskContext.strokeStyle = "#35d67a";
    maskContext.lineWidth = 2;
    maskContext.beginPath();
    maskContext.moveTo(pathStart.x, pathStart.y);
    maskContext.lineTo(pathEnd.x, pathEnd.y);
    maskContext.stroke();

    return {
      local: {
        changedPixels,
        interiorPixels,
        changedRatio: changedPixels / interiorPixels,
        unchangedRatio: (interiorPixels - changedPixels) / interiorPixels,
        offPathChangedPixels,
        offPathChangeRatio: offPathChangedPixels / Math.max(1, changedPixels),
        coveredProbes,
        probeCount: plan.probes.length,
        largestConnectedPixels,
        largestConnectedRatio: largestConnectedPixels / Math.max(1, changedPixels),
        pathSpanRatio: largestPathSpan / pathLength,
      },
      erase: {
        centerPaintPixels,
        centerRestoredPixels,
        centerRestoreRatio: centerRestoredPixels / Math.max(1, centerPaintPixels),
        endPaintPixels,
        endRetainedPixels,
        endRetainRatio: endRetainedPixels / Math.max(1, endPaintPixels),
        changedOutsideCapsulePixels,
        changedOutsideCapsuleInteriorRatio: changedOutsideCapsulePixels / interiorPixels,
      },
      anchoring: {
        leftChangedPixels,
        leftOutsideSilhouettePixels,
        leftOutsideSilhouetteRatio: leftOutsideSilhouettePixels / Math.max(1, leftChangedPixels),
        centroidDisplacementPixels: Math.hypot(leftCentroidX - anteriorCentroidX, leftCentroidY - anteriorCentroidY),
        returnedAnteriorMaskIou: maskIou(paintedMask, returnedMask),
      },
      undo: {
        maskIou: maskIou(paintedMask, undoMask),
        meanRgbError: meanRgbError(painted, undo, baselineInterior),
      },
      reload: {
        maskIou: maskIou(paintedMask, reloadMask),
        meanRgbError: meanRgbError(painted, reload, baselineInterior),
      },
      maskPngBase64: maskCanvas.toDataURL("image/png").slice("data:image/png;base64,".length),
    };
  }, { encoded: rasters, plan: input.plan, threshold: CHANGE_THRESHOLD });
}

async function readSurfaceState(page: Page): Promise<SurfaceRead> {
  const raw = await executeTool(page, "page_anatomy_coloring_read", {});
  return {
    colored: requiredNumber(raw, "colored"),
    surfaceStrokeCount: requiredNumber(raw, "surfaceStrokeCount"),
    surfaceAnchorCount: requiredNumber(raw, "surfaceAnchorCount"),
    surfaceStateFingerprint: requiredString(raw, "surfaceStateFingerprint"),
    raw,
  };
}

async function openFrontalWorkspace(page: Page): Promise<Readonly<{
  root: Locator;
  canvas: Locator;
}>> {
  const root = page.locator('.anatomy-coloring-card[data-section="skull"][data-atlas-state="ready"]');
  await expect(root).toBeVisible({ timeout: 30_000 });
  const canvas = root.locator(".anatomy-model-canvas canvas");
  await waitForExactCanvas(canvas);
  await root.getByRole("option", { name: /Frontal bone/ }).click();
  await expect(root).toHaveAttribute("data-workspace-bone", "frontal-bone");
  await expect(root.getByRole("button", { name: "Paint" })).toHaveAttribute("aria-pressed", "true");
  await expect(canvas).toHaveAttribute("data-visible-semantic-meshes", "1");
  await expect(canvas).toHaveAttribute("data-surface-paint", "enabled");
  await root.getByRole("button", { name: "Reset view" }).click();
  await waitForExactCanvas(canvas);
  return { root, canvas };
}

async function pageTwoAfterReload(page: Page): Promise<void> {
  await waitForTools(page, ["page_context_read", "page_anatomy_coloring_read"]);
  const context = requiredRecord(await executeTool(page, "page_context_read", {}), "context");
  const focusedPageNumber = requiredNumber(context, "focusedPageNumber");
  if (focusedPageNumber === 1) await page.getByRole("button", { name: "Next" }).click();
  else if (focusedPageNumber !== 2) throw new Error(`Reload focused unexpected anatomy page ${focusedPageNumber}.`);
}

test.beforeEach(async ({ context }) => {
  await installAnatomyAcceptanceBridge(context);
});

test(TEST_TITLE, async ({ page }, testInfo) => {
  expect(testInfo.project.name).toBe("anatomy-desktop");
  const issues = observeBrowser(page);
  await createAtlasNotebook(page, "Local surface paint acceptance");
  await page.getByRole("button", { name: "Next" }).click();
  await waitForTools(page, ["page_context_read", "page_anatomy_coloring_read"]);
  let { root, canvas } = await openFrontalWorkspace(page);
  await expect(page.locator(".anatomy-model-canvas canvas"), "Only one live anatomy canvas may exist.").toHaveCount(1);

  const baseline = await captureCanvas(page, canvas, testInfo.outputPath("surface-baseline.png"));
  const plan = await deriveStrokePlan(page, baseline);
  expect(plan.interiorPixels).toBeGreaterThan(1_000);
  expect(plan.path).toHaveLength(96);

  await root.getByRole("button", { name: "Left", exact: true }).click();
  const leftBaseline = await captureCanvas(page, canvas, testInfo.outputPath("surface-left-baseline.png"));
  await root.getByRole("button", { name: "Anterior", exact: true }).click();
  await waitForExactCanvas(canvas);
  await expect(root.getByRole("button", { name: "Sweep", exact: true })).toHaveAttribute("aria-pressed", "true");
  await root.getByRole("button", { name: "Cobalt", exact: true }).click();
  await expect(root).toHaveAttribute("data-paint-state", "idle");

  const beforePaint = await readSurfaceState(page);
  expect(beforePaint.surfaceStrokeCount).toBe(0);
  expect(beforePaint.surfaceAnchorCount).toBe(0);
  const canvasBox = await canvas.boundingBox();
  if (canvasBox === null) throw new Error("The isolated surface-paint canvas has no bounding box.");
  const cssPath = plan.path.map((point) => ({
    x: canvasBox.x + point.x / plan.imageWidth * canvasBox.width,
    y: canvasBox.y + point.y / plan.imageHeight * canvasBox.height,
  }));
  const firstPoint = cssPath[0];
  if (firstPoint === undefined) throw new Error("The surface-paint path is empty.");

  await page.evaluate(() => {
    const paintCanvas = document.querySelector('.anatomy-coloring-card[data-section="skull"] .anatomy-model-canvas canvas');
    if (!(paintCanvas instanceof HTMLCanvasElement)) throw new Error("The surface-paint canvas is unavailable.");
    delete paintCanvas.dataset.acceptancePointerDown;
    delete paintCanvas.dataset.acceptancePointerUp;
    paintCanvas.addEventListener("pointerdown", () => {
      paintCanvas.dataset.acceptancePointerDown = String(performance.now());
    }, { once: true });
    paintCanvas.addEventListener("pointerup", () => {
      paintCanvas.dataset.acceptancePointerUp = String(performance.now());
    }, { once: true });
    window.__anatomyAcceptance.resetDrawStats();
    window.__anatomyAcceptance.resetLongTasks();
  });
  const rafSamplesPromise = page.evaluate((sampleCount) => new Promise<number[]>((resolve) => {
    const intervals: number[] = [];
    let previous: number | null = null;
    const sample = (timestamp: number): void => {
      if (previous !== null) intervals.push(timestamp - previous);
      previous = timestamp;
      if (intervals.length >= sampleCount) resolve(intervals);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), 75);
  await page.mouse.move(firstPoint.x, firstPoint.y);
  await page.mouse.down();
  for (const point of cssPath.slice(1)) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(6);
  }
  await page.mouse.up();
  await expect(root).toHaveAttribute("data-paint-state", "idle", { timeout: 5_000 });
  await expect(root).toHaveAttribute("data-surface-strokes", "1");
  const persistedAt = await page.evaluate(() => performance.now());
  const afterPaint = await readSurfaceState(page);
  const rafIntervals = await rafSamplesPromise;
  const paintTiming = await canvas.evaluate((element) => ({
    pointerDownAt: Number(element.dataset.acceptancePointerDown),
    pointerUpAt: Number(element.dataset.acceptancePointerUp),
    paintedVertices: Number(element.dataset.surfacePaintPaintedVertices),
    lastStampVertices: Number(element.dataset.surfacePaintLastStampVertices),
    adjacencyVertices: Number(element.dataset.surfacePaintAdjacencyVertices),
    uploadedVertices: Number(element.dataset.surfacePaintUploadVertices),
    previewAnchors: Number(element.dataset.surfacePaintPreviewAnchors),
    rendererStrokes: Number(element.dataset.surfacePaintStrokes),
    rendererAnchors: Number(element.dataset.surfacePaintAnchors),
    drawCalls: Number(element.dataset.atlasDrawCalls),
  }));
  const drawStats = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  const firstPreviewAt = drawStats.clearTimestamps.find((timestamp) => timestamp >= paintTiming.pointerDownAt) ?? Number.NaN;
  const previewLatencyMs = firstPreviewAt - paintTiming.pointerDownAt;
  const persistLatencyMs = persistedAt - paintTiming.pointerUpAt;
  const longTasks = await page.evaluate(() => window.__anatomyAcceptance.longTasks());
  expect(afterPaint.surfaceStrokeCount, "One pointer gesture must persist one stroke.").toBe(1);
  expect(afterPaint.surfaceAnchorCount, "A drag must persist more than one anchored sample.").toBeGreaterThan(1);
  expect(afterPaint.surfaceAnchorCount, "A stroke must remain under the command boundary's sample cap.")
    .toBeLessThanOrEqual(MAX_SURFACE_PAINT_ANCHORS_PER_STROKE);
  expect(paintTiming.rendererStrokes).toBe(1);
  expect(paintTiming.rendererAnchors).toBe(afterPaint.surfaceAnchorCount);
  expect(paintTiming.previewAnchors).toBe(0);
  expect(paintTiming.paintedVertices).toBeGreaterThan(0);
  expect(paintTiming.paintedVertices).toBeLessThan(paintTiming.adjacencyVertices);
  expect(paintTiming.uploadedVertices).toBeGreaterThan(0);
  expect(paintTiming.drawCalls).toBeGreaterThan(0);
  expect(paintTiming.drawCalls).toBeLessThanOrEqual(MAX_SETTLED_DRAW_CALLS);
  expect(previewLatencyMs, "The first brush preview must render within 50 ms of pointerdown.").toBeLessThanOrEqual(MAX_PREVIEW_LATENCY_MS);
  expect(persistLatencyMs, "Pointerup through app-owned persistence must finish within 300 ms.").toBeLessThanOrEqual(MAX_PERSIST_LATENCY_MS);
  expect(percentile(rafIntervals, 95), "Painting rAF p95 must stay within two 60 Hz frames.").toBeLessThanOrEqual(MAX_PAINT_RAF_P95_MS);
  expect(Math.max(...rafIntervals), "No painting frame may exceed 100 ms.").toBeLessThanOrEqual(MAX_PAINT_RAF_MS);
  expect(longTasks.filter((duration) => duration >= 50), "Painting must create no 50 ms long tasks.").toEqual([]);

  const painted = await captureCanvas(page, canvas, testInfo.outputPath("surface-painted.png"));
  await root.getByRole("button", { name: "Left", exact: true }).click();
  const paintedLeft = await captureCanvas(page, canvas, testInfo.outputPath("surface-painted-left.png"));
  await root.getByRole("button", { name: "Anterior", exact: true }).click();
  const returnedAnterior = await captureCanvas(page, canvas, testInfo.outputPath("surface-returned-anterior.png"));

  await root.getByRole("button", { name: "Eraser", exact: true }).click();
  const eraserPath = cssPath.slice(Math.floor(cssPath.length * 0.34), Math.ceil(cssPath.length * 0.67));
  const eraserStart = eraserPath[0];
  if (eraserStart === undefined) throw new Error("The local eraser path is empty.");
  await page.mouse.move(eraserStart.x, eraserStart.y);
  await page.mouse.down();
  for (const point of eraserPath.slice(1)) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(6);
  }
  await page.mouse.up();
  await expect(root).toHaveAttribute("data-paint-state", "idle", { timeout: 5_000 });
  await expect(root).toHaveAttribute("data-surface-strokes", "2");
  const afterErase = await readSurfaceState(page);
  expect(afterErase.surfaceStrokeCount).toBe(2);
  const erased = await captureCanvas(page, canvas, testInfo.outputPath("surface-erased.png"));

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(root).toHaveAttribute("data-paint-state", "idle", { timeout: 5_000 });
  await expect(root).toHaveAttribute("data-surface-strokes", "1", { timeout: 5_000 });
  const afterUndo = await readSurfaceState(page);
  expect(afterUndo.surfaceStrokeCount).toBe(1);
  expect(afterUndo.surfaceAnchorCount).toBe(afterPaint.surfaceAnchorCount);
  expect(afterUndo.surfaceStateFingerprint).toBe(afterPaint.surfaceStateFingerprint);
  const undo = await captureCanvas(page, canvas, testInfo.outputPath("surface-undo.png"));

  await page.reload({ waitUntil: "domcontentloaded" });
  await pageTwoAfterReload(page);
  ({ root, canvas } = await openFrontalWorkspace(page));
  await expect(page.locator(".anatomy-model-canvas canvas"), "Reload must remount exactly one anatomy canvas.").toHaveCount(1);
  const afterReload = await readSurfaceState(page);
  expect(afterReload.surfaceStrokeCount).toBe(1);
  expect(afterReload.surfaceAnchorCount).toBe(afterPaint.surfaceAnchorCount);
  expect(afterReload.surfaceStateFingerprint).toBe(afterPaint.surfaceStateFingerprint);
  const reload = await captureCanvas(page, canvas, testInfo.outputPath("surface-reload.png"));

  const hiddenRead = JSON.stringify(afterReload.raw).toLocaleLowerCase();
  expect(hiddenRead).not.toContain("frontal");
  expect(hiddenRead).not.toContain("left-parietal");
  await root.getByRole("button", { name: "Label yourself" }).click();
  await expect(root).toHaveAttribute("data-workspace-bone", "question-1");
  const firstAnswer = root.getByRole("textbox", { name: "Coloring answer for question 1", exact: true });
  await expect(firstAnswer).toBeFocused();
  const recallEvidence = await Promise.all([
    root.evaluate((element) => element.outerHTML.toLocaleLowerCase()),
    root.ariaSnapshot().then((value) => value.toLocaleLowerCase()),
    executeTool(page, "page_anatomy_coloring_read", {}).then((value) => JSON.stringify(value).toLocaleLowerCase()),
  ]);
  for (const evidence of recallEvidence) {
    expect(evidence).not.toContain("frontal bone");
    expect(evidence).not.toContain("frontal-bone");
    expect(evidence).not.toContain("left parietal");
    expect(evidence).not.toContain("left-parietal");
  }
  await firstAnswer.fill("Frontal bone");
  await firstAnswer.press("Enter");
  await expect(root.getByRole("textbox", { name: "Coloring answer for question 2", exact: true })).toBeFocused();
  await expect(root).toHaveAttribute("data-workspace-bone", "question-2");
  const afterProgression = await readSurfaceState(page);
  expect(afterProgression.surfaceStrokeCount).toBe(1);
  expect(afterProgression.surfaceStateFingerprint).toBe(afterPaint.surfaceStateFingerprint);

  const metrics = await analyzePaintRasters(page, {
    plan,
    baseline,
    leftBaseline,
    painted,
    paintedLeft,
    returnedAnterior,
    erased,
    undo,
    reload,
  });
  await writeFile(testInfo.outputPath("surface-paint-mask.png"), Buffer.from(metrics.maskPngBase64, "base64"));
  await writeEvidence(testInfo, "surface-paint-metrics.json", {
    status: "captured-before-assertions",
    thresholds: {
      changeThreshold: CHANGE_THRESHOLD,
      minLocalCoverage: MIN_LOCAL_COVERAGE,
      maxLocalCoverage: MAX_LOCAL_COVERAGE,
      minUnchangedCoverage: MIN_UNCHANGED_COVERAGE,
      maxBrushTriangleSpillRatio: MAX_BRUSH_TRIANGLE_SPILL_RATIO,
      maxOutsideSilhouetteRatio: MAX_OUTSIDE_SILHOUETTE_RATIO,
      minConnectedChangeRatio: MIN_CONNECTED_CHANGE_RATIO,
      minPathSpanRatio: MIN_PATH_SPAN_RATIO,
      minEraseCenterRestoreRatio: MIN_ERASE_CENTER_RESTORE_RATIO,
      minEraseEndRetainRatio: MIN_ERASE_END_RETAIN_RATIO,
      maxEraseOffPathInteriorRatio: MAX_ERASE_OFF_PATH_INTERIOR_RATIO,
      minUndoMaskIou: MIN_UNDO_MASK_IOU,
      minReloadMaskIou: MIN_RELOAD_MASK_IOU,
      maxReplayMeanRgbError: MAX_REPLAY_MEAN_RGB_ERROR,
      maxPreviewLatencyMs: MAX_PREVIEW_LATENCY_MS,
      maxPersistLatencyMs: MAX_PERSIST_LATENCY_MS,
      maxPaintRafP95Ms: MAX_PAINT_RAF_P95_MS,
      maxPaintRafMs: MAX_PAINT_RAF_MS,
      maxSettledDrawCalls: MAX_SETTLED_DRAW_CALLS,
    },
    plan,
    state: { beforePaint, afterPaint, afterErase, afterUndo, afterReload, afterProgression },
    timing: {
      previewLatencyMs,
      persistLatencyMs,
      rafSamples: rafIntervals.length,
      rafMedianMs: percentile(rafIntervals, 50),
      rafP95Ms: percentile(rafIntervals, 95),
      rafMaxMs: Math.max(...rafIntervals),
      longTasks,
      drawStats,
    },
    renderer: paintTiming,
    visual: metrics,
  });
  expect(metrics.local.changedRatio, "A local stroke must visibly change at least 0.5% of the bone interior.")
    .toBeGreaterThanOrEqual(MIN_LOCAL_COVERAGE);
  expect(metrics.local.changedRatio, "A local stroke must not recolor more than 30% of the same bone interior.")
    .toBeLessThanOrEqual(MAX_LOCAL_COVERAGE);
  expect(metrics.local.unchangedRatio, "At least 65% of the same bone must stay at its baseline material.")
    .toBeGreaterThanOrEqual(MIN_UNCHANGED_COVERAGE);
  expect(metrics.local.offPathChangeRatio, "Surface paint must stay within the bounded source-triangle brush allowance.")
    .toBeLessThanOrEqual(MAX_BRUSH_TRIANGLE_SPILL_RATIO);
  expect(metrics.local.coveredProbes, "One drag must produce a continuous visible trail through all nine probes.")
    .toBe(MIN_PROBE_COVERAGE);
  expect(metrics.local.largestConnectedRatio, "At least 75% of painted pixels must form one connected trail.")
    .toBeGreaterThanOrEqual(MIN_CONNECTED_CHANGE_RATIO);
  expect(metrics.local.pathSpanRatio, "The connected paint trail must span at least 85% of the intended path.")
    .toBeGreaterThanOrEqual(MIN_PATH_SPAN_RATIO);
  expect(metrics.erase.centerRestoreRatio, "The local eraser must restore at least 60% of the painted center.")
    .toBeGreaterThanOrEqual(MIN_ERASE_CENTER_RESTORE_RATIO);
  expect(metrics.erase.endRetainRatio, "The local eraser must retain at least 80% of both painted ends.")
    .toBeGreaterThanOrEqual(MIN_ERASE_END_RETAIN_RATIO);
  expect(metrics.erase.changedOutsideCapsuleInteriorRatio, "The eraser must not modify distant surface paint.")
    .toBeLessThanOrEqual(MAX_ERASE_OFF_PATH_INTERIOR_RATIO);
  expect(metrics.anchoring.leftChangedPixels, "The painted region must remain visible after a true 3D camera change.")
    .toBeGreaterThan(0);
  expect(metrics.anchoring.leftOutsideSilhouetteRatio, "Paint must stay attached to the left-view bone silhouette.")
    .toBeLessThanOrEqual(MAX_OUTSIDE_SILHOUETTE_RATIO);
  expect(metrics.anchoring.centroidDisplacementPixels, "The paint must move with the 3D bone, not remain a screen overlay.")
    .toBeGreaterThan(8);
  expect(metrics.anchoring.returnedAnteriorMaskIou, "Returning anterior must recover the original attached paint mask.")
    .toBeGreaterThanOrEqual(MIN_RELOAD_MASK_IOU);
  expect(metrics.undo.maskIou, "Undo must restore the exact pre-eraser paint mask.").toBeGreaterThanOrEqual(MIN_UNDO_MASK_IOU);
  expect(metrics.undo.meanRgbError, "Undo replay must stay within two RGB levels of the painted image.")
    .toBeLessThanOrEqual(MAX_REPLAY_MEAN_RGB_ERROR);
  expect(metrics.reload.maskIou, "Reload must reproduce the saved paint mask.").toBeGreaterThanOrEqual(MIN_RELOAD_MASK_IOU);
  expect(metrics.reload.meanRgbError, "Reload replay must stay within two RGB levels of the painted image.")
    .toBeLessThanOrEqual(MAX_REPLAY_MEAN_RGB_ERROR);

  await waitForExactCanvas(canvas);
  const idleStart = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  await page.waitForTimeout(750);
  const idleEnd = await page.evaluate(() => window.__anatomyAcceptance.drawStats());
  expect(idleEnd.clears - idleStart.clears, "A settled painted atlas must not keep rendering while idle.").toBe(0);
  expectNoBrowserErrors(issues);

  await writeFile(testInfo.outputPath("surface-paint-mask.png"), Buffer.from(metrics.maskPngBase64, "base64"));
  await writeEvidence(testInfo, "surface-paint-metrics.json", {
    thresholds: {
      changeThreshold: CHANGE_THRESHOLD,
      minLocalCoverage: MIN_LOCAL_COVERAGE,
      maxLocalCoverage: MAX_LOCAL_COVERAGE,
      minUnchangedCoverage: MIN_UNCHANGED_COVERAGE,
      maxBrushTriangleSpillRatio: MAX_BRUSH_TRIANGLE_SPILL_RATIO,
      maxOutsideSilhouetteRatio: MAX_OUTSIDE_SILHOUETTE_RATIO,
      minConnectedChangeRatio: MIN_CONNECTED_CHANGE_RATIO,
      minPathSpanRatio: MIN_PATH_SPAN_RATIO,
      minEraseCenterRestoreRatio: MIN_ERASE_CENTER_RESTORE_RATIO,
      minEraseEndRetainRatio: MIN_ERASE_END_RETAIN_RATIO,
      maxEraseOffPathInteriorRatio: MAX_ERASE_OFF_PATH_INTERIOR_RATIO,
      minUndoMaskIou: MIN_UNDO_MASK_IOU,
      minReloadMaskIou: MIN_RELOAD_MASK_IOU,
      maxReplayMeanRgbError: MAX_REPLAY_MEAN_RGB_ERROR,
      maxPreviewLatencyMs: MAX_PREVIEW_LATENCY_MS,
      maxPersistLatencyMs: MAX_PERSIST_LATENCY_MS,
      maxPaintRafP95Ms: MAX_PAINT_RAF_P95_MS,
      maxPaintRafMs: MAX_PAINT_RAF_MS,
      maxSettledDrawCalls: MAX_SETTLED_DRAW_CALLS,
    },
    plan,
    state: { beforePaint, afterPaint, afterErase, afterUndo, afterReload, afterProgression },
    timing: {
      previewLatencyMs,
      persistLatencyMs,
      rafSamples: rafIntervals.length,
      rafMedianMs: percentile(rafIntervals, 50),
      rafP95Ms: percentile(rafIntervals, 95),
      rafMaxMs: Math.max(...rafIntervals),
      longTasks,
      drawStats,
      idleClearDelta: idleEnd.clears - idleStart.clears,
    },
    renderer: paintTiming,
    visual: metrics,
  });
});
