import {
  PAGE_CONTENT_RECT,
  diagramMinimumFrame,
  type ElementId,
  type PageRecord,
  type PageRect,
} from "./domain";
import { layoutPage } from "./layout";
import type { VectorInkDocument } from "./vector-ink";

const DEFAULT_SHAPE_SIZE: Readonly<{ width: number; height: number }> = { width: 96, height: 96 };
const SHAPE_PLACEMENT_GRID = 8;
const SHAPE_PLACEMENT_GUTTER = 16;

export class PagePlacementError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PagePlacementError";
  }
}

function rectanglesOverlap(left: PageRect, right: PageRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function isWithinRect(frame: PageRect, bounds: PageRect): boolean {
  return frame.x >= bounds.x
    && frame.y >= bounds.y
    && frame.x + frame.width <= bounds.x + bounds.width
    && frame.y + frame.height <= bounds.y + bounds.height;
}

function alignUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function alignDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function rectanglesHaveGutter(left: PageRect, right: PageRect, gutter: number): boolean {
  return left.x + left.width + gutter <= right.x
    || right.x + right.width + gutter <= left.x
    || left.y + left.height + gutter <= right.y
    || right.y + right.height + gutter <= left.y;
}

export function shapeFrame(page: PageRecord, requestedFrame: PageRect | undefined): PageRect {
  if (requestedFrame !== undefined) return requestedFrame;

  const contentRect = layoutPage(page).metrics.contentRect;
  const firstX = alignUp(contentRect.x + SHAPE_PLACEMENT_GUTTER, SHAPE_PLACEMENT_GRID);
  const firstY = alignUp(contentRect.y + SHAPE_PLACEMENT_GUTTER, SHAPE_PLACEMENT_GRID);
  const lastX = alignDown(
    contentRect.x + contentRect.width - SHAPE_PLACEMENT_GUTTER - DEFAULT_SHAPE_SIZE.width,
    SHAPE_PLACEMENT_GRID,
  );
  const lastY = contentRect.y + contentRect.height - SHAPE_PLACEMENT_GUTTER - DEFAULT_SHAPE_SIZE.height;

  for (let x = lastX; x >= firstX; x -= SHAPE_PLACEMENT_GRID) {
    for (let y = firstY; y <= lastY; y += SHAPE_PLACEMENT_GRID) {
      const candidate: PageRect = { x, y, ...DEFAULT_SHAPE_SIZE };
      if (page.elements.every((element) =>
        rectanglesHaveGutter(candidate, element.frame, SHAPE_PLACEMENT_GUTTER))) {
        return candidate;
      }
    }
  }

  throw new PagePlacementError("No safe shape position is available on this page.");
}

export function assertSafeVectorFrame(
  page: PageRecord,
  frame: PageRect,
  excludedElementId?: ElementId,
): void {
  if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y)
    || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)
    || frame.width <= 0 || frame.height <= 0) {
    throw new PagePlacementError("A vector figure needs a finite positive frame.");
  }
  if (frame.width < 96 || frame.height < 48) {
    throw new PagePlacementError("A vector figure must remain at least 96 by 48.");
  }
  if (!isWithinRect(frame, PAGE_CONTENT_RECT)) {
    throw new PagePlacementError("A vector figure must remain inside the page content area.");
  }
  const collision = page.elements.some((element) =>
    element.id !== excludedElementId && element.kind !== "annotation" && rectanglesOverlap(frame, element.frame));
  if (collision) {
    throw new PagePlacementError("A vector figure cannot obscure existing page content.");
  }
}

export function assertSafeDiagramFrame(page: PageRecord, frame: PageRect, excludedElementId: ElementId): void {
  const minimum = diagramMinimumFrame(page);
  const contentRect = layoutPage(page).metrics.contentRect;
  if (frame.width < minimum.width - 1e-6 || frame.height < minimum.height - 1e-6 || !isWithinRect(frame, contentRect)) {
    throw new PagePlacementError("A diagram must remain inside the page content area at an editable size.");
  }
  if (page.elements.some((element) => {
    if (element.id === excludedElementId) return false;
    const occupiesVisibleContent = element.kind !== "annotation"
      || (element.annotation === "label" && element.text !== undefined && element.text.trim().length > 0);
    return occupiesVisibleContent && rectanglesOverlap(frame, element.frame);
  })) {
    throw new PagePlacementError("A diagram cannot obscure existing page content.");
  }
}

export function vectorInkFrame(
  page: PageRecord,
  document: VectorInkDocument,
  requestedFrame: PageRect | undefined,
  excludedElementId?: ElementId,
): PageRect {
  if (requestedFrame !== undefined) {
    assertSafeVectorFrame(page, requestedFrame, excludedElementId);
    return requestedFrame;
  }

  const aspect = document.viewBox.width / document.viewBox.height;
  const maxWidth = Math.min(PAGE_CONTENT_RECT.width, 320);
  const maxHeight = Math.min(PAGE_CONTENT_RECT.height, 240);
  let width = maxWidth;
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PagePlacementError("The vector figure has no usable aspect ratio.");
  }

  const step = 16;
  const maxX = PAGE_CONTENT_RECT.x + PAGE_CONTENT_RECT.width - width;
  const maxY = PAGE_CONTENT_RECT.y + PAGE_CONTENT_RECT.height - height;
  for (let y = PAGE_CONTENT_RECT.y; y <= maxY; y += step) {
    for (let x = PAGE_CONTENT_RECT.x; x <= maxX; x += step) {
      const candidate = { x, y, width, height };
      try {
        assertSafeVectorFrame(page, candidate, excludedElementId);
        return candidate;
      } catch (error: unknown) {
        if (!(error instanceof PagePlacementError)) throw error;
      }
    }
  }
  throw new PagePlacementError("No safe vector figure position is available on this page.");
}
