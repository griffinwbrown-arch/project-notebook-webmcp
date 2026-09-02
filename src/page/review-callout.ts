import {
  PAGE_CONTENT_RECT,
  PAGE_WIDTH,
  rectsOverlap,
  type PageRecord,
  type PageRect,
} from "./domain";

export const REVIEW_CALLOUT_WIDTH = 220;
export const REVIEW_CALLOUT_MIN_WIDTH = 160;
export const REVIEW_CALLOUT_MIN_HEIGHT = 64;
const REVIEW_CALLOUT_GAP = 12;
const REVIEW_CALLOUT_LINE_HEIGHT = 17;
const REVIEW_CALLOUT_VERTICAL_PADDING = 52;

function contentRect(page: PageRecord): PageRect {
  const scale = page.size.width / PAGE_WIDTH;
  return {
    x: PAGE_CONTENT_RECT.x * scale,
    y: PAGE_CONTENT_RECT.y * scale,
    width: page.size.width - PAGE_CONTENT_RECT.x * scale * 2,
    height: page.size.height - PAGE_CONTENT_RECT.y * scale * 2,
  };
}

function words(text: string): readonly string[] {
  return text.trim().split(/\s+/).filter((word) => word.length > 0);
}

export function wrapReviewCalloutText(text: string, width: number): readonly string[] {
  const maximumCharacters = Math.max(12, Math.floor((width - 24) / 7.2));
  const lines: string[] = [];
  const units = words(text).flatMap((word) => {
    if (word.length <= maximumCharacters) return [{ text: word, separated: true }];
    const chunks: Array<{ text: string; separated: boolean }> = [];
    for (let index = 0; index < word.length; index += maximumCharacters) {
      chunks.push({ text: word.slice(index, index + maximumCharacters), separated: index === 0 });
    }
    return chunks;
  });
  for (const unit of units) {
    const previous = lines.at(-1);
    const separator = unit.separated && previous !== undefined ? " " : "";
    if (previous === undefined || previous.length + separator.length + unit.text.length > maximumCharacters) {
      lines.push(unit.text);
    } else {
      lines[lines.length - 1] = `${previous}${separator}${unit.text}`;
    }
  }
  return lines.length === 0 ? [""] : lines;
}

export function reviewCalloutHeight(text: string, width: number): number {
  return Math.max(
    REVIEW_CALLOUT_MIN_HEIGHT,
    REVIEW_CALLOUT_VERTICAL_PADDING + wrapReviewCalloutText(text, width).length * REVIEW_CALLOUT_LINE_HEIGHT,
  );
}

function inside(inner: PageRect, outer: PageRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}

export function findReviewCalloutFrame(
  page: PageRecord,
  targetContainer: PageRect,
  text: string,
): PageRect | null {
  const bounds = contentRect(page);
  const width = Math.min(REVIEW_CALLOUT_WIDTH, bounds.width);
  const height = reviewCalloutHeight(text, width);
  const candidates: readonly PageRect[] = [
    { x: targetContainer.x + targetContainer.width + REVIEW_CALLOUT_GAP, y: targetContainer.y, width, height },
    { x: targetContainer.x, y: targetContainer.y + targetContainer.height + REVIEW_CALLOUT_GAP, width, height },
    { x: targetContainer.x, y: targetContainer.y - height - REVIEW_CALLOUT_GAP, width, height },
    { x: targetContainer.x - width - REVIEW_CALLOUT_GAP, y: targetContainer.y, width, height },
    { x: bounds.x, y: targetContainer.y + targetContainer.height + REVIEW_CALLOUT_GAP, width, height },
    { x: bounds.x + bounds.width - width, y: targetContainer.y + targetContainer.height + REVIEW_CALLOUT_GAP, width, height },
  ];
  const obstacles = page.elements.filter((element) =>
    element.kind !== "annotation" || element.reviewKind !== undefined,
  );
  return candidates.find((candidate) =>
    inside(candidate, bounds) && obstacles.every((element) => !rectsOverlap(candidate, element.frame)),
  ) ?? null;
}

function center(rect: PageRect): Readonly<{ x: number; y: number }> {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function nearestRelationshipTarget(
  source: PageRect,
  targets: readonly PageRect[],
): PageRect | null {
  const sourceCenter = center(source);
  return targets.reduce<PageRect | null>((nearest, target) => {
    if (nearest === null) return target;
    const targetCenter = center(target);
    const nearestCenter = center(nearest);
    const targetDistance = Math.hypot(targetCenter.x - sourceCenter.x, targetCenter.y - sourceCenter.y);
    const nearestDistance = Math.hypot(nearestCenter.x - sourceCenter.x, nearestCenter.y - sourceCenter.y);
    return targetDistance < nearestDistance ? target : nearest;
  }, null);
}
