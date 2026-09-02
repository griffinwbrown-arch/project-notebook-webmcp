"use client";

import { useEffect, useRef, useState } from "react";

import type {
  ColoringBookProps,
  ColoringEdit,
  ColoringStroke,
} from "../../learning/activities";

const COLOR_PALETTE = ["#d55b45", "#e2a52b", "#4f8c62", "#3e7fa6", "#765da8", "#252a2d"] as const;
const DRAWING_REFERENCE_WIDTH = 672;

type DrawingTool = "pen" | "eraser";

function sceneArtwork(scene: ColoringBookProps["scene"]): React.JSX.Element {
  if (scene === "garden") {
    return (
      <g>
        <path d="M76 566 C185 510 252 526 340 578 C438 635 546 593 646 536" />
        <path d="M354 561 C348 442 357 322 366 205" />
        <path d="M364 312 C292 265 225 278 185 337 C256 346 317 348 364 312Z" />
        <path d="M361 393 C430 335 509 340 555 403 C479 415 414 425 361 393Z" />
        <path d="M364 239 C317 202 277 211 249 251 C300 262 333 264 364 239Z" />
        <circle cx="366" cy="174" r="49" />
        <circle cx="366" cy="174" r="17" />
        {Array.from({ length: 10 }, (_, index) => (
          <ellipse key={index} cx="366" cy="112" rx="24" ry="54" transform={`rotate(${index * 36} 366 174)`} />
        ))}
        <path d="M104 549 Q87 455 135 407 Q185 459 158 549" />
        <path d="M559 556 Q538 468 588 420 Q635 468 614 544" />
        <path d="M120 468 C73 449 54 411 62 368 C110 390 136 423 120 468Z" />
        <path d="M591 479 C642 458 663 420 655 374 C606 396 577 433 591 479Z" />
        <circle cx="137" cy="387" r="24" />
        <circle cx="588" cy="399" r="24" />
      </g>
    );
  }
  if (scene === "tide-pool") {
    return (
      <g>
        <path d="M48 124 C151 70 217 160 316 111 C414 63 507 137 672 83" />
        <path d="M54 574 C155 498 237 602 340 548 C448 492 544 583 671 520" />
        <path d="M112 509 C87 409 108 293 157 221 C191 318 188 432 163 521" />
        <path d="M145 375 C92 348 72 308 79 260 C131 279 160 324 145 375Z" />
        <path d="M151 439 C206 414 233 370 225 319 C174 342 139 387 151 439Z" />
        <path d="M404 279 C456 214 562 215 620 280 C554 338 463 342 404 279Z" />
        <circle cx="563" cy="272" r="6" />
        <path d="M410 280 L362 238 L365 321 Z" />
        <path d="M456 230 Q484 171 513 232" />
        <path d="M282 489 C249 431 262 366 326 336 C375 373 383 439 347 489Z" />
        <path d="M326 336 L316 479 M282 393 L370 414 M290 454 L360 377" />
        <circle cx="249" cy="214" r="39" />
        <circle cx="248" cy="214" r="17" />
        <path d="M246 175 C222 137 186 129 160 151 M283 208 C326 187 351 202 368 231" />
        <circle cx="548" cy="445" r="15" />
        <circle cx="598" cy="396" r="10" />
        <circle cx="633" cy="454" r="24" />
      </g>
    );
  }
  return (
    <g>
      <path d="M83 531 C198 472 309 551 417 501 C506 459 589 493 655 456" />
      <circle cx="560" cy="146" r="76" />
      <path d="M521 85 C548 111 545 166 513 197 C556 231 620 197 634 145 C627 91 578 60 521 85Z" />
      <path d="M359 351 C319 288 246 274 187 310 C220 369 289 398 359 351Z" />
      <path d="M359 351 C399 288 472 274 531 310 C498 369 429 398 359 351Z" />
      <path d="M359 351 C330 406 332 467 359 512 C386 467 388 406 359 351Z" />
      <ellipse cx="359" cy="344" rx="15" ry="84" />
      <path d="M351 267 Q327 218 292 215 M367 267 Q391 218 426 215" />
      <circle cx="292" cy="215" r="7" />
      <circle cx="426" cy="215" r="7" />
      <path d="M214 324 C253 325 290 344 321 373 M504 324 C465 325 428 344 397 373" />
      <path d="M120 522 Q134 436 204 404 Q217 474 188 530" />
      <path d="M536 504 Q550 424 618 392 Q635 459 607 508" />
      <path d="M111 144 l9 20 22 3-16 16 4 23-19-11-20 11 4-23-16-16 22-3z" />
      <path d="M232 112 l7 14 16 2-12 12 3 16-14-8-14 8 3-16-12-12 16-2z" />
      <path d="M132 286 l6 13 15 2-11 10 3 15-13-7-13 7 3-15-11-10 15-2z" />
    </g>
  );
}

function drawStroke(
  context: CanvasRenderingContext2D,
  stroke: ColoringStroke,
  width: number,
  height: number,
): void {
  const first = stroke.points[0];
  if (first === undefined) return;
  context.save();
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.width * (width / DRAWING_REFERENCE_WIDTH);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  context.moveTo(first.x * width, first.y * height);
  if (stroke.points.length === 1) {
    context.lineTo(first.x * width + .01, first.y * height + .01);
  } else {
    for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
  }
  context.stroke();
  context.restore();
}

export type ColoringBookPageViewProps = Readonly<{
  props: ColoringBookProps;
  disabled: boolean;
  onEdit: (edit: ColoringEdit) => Promise<boolean>;
}>;

export function ColoringBookPage({ props, disabled, onEdit }: ColoringBookPageViewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerId = useRef<number | null>(null);
  const activeStroke = useRef<ColoringStroke | null>(null);
  const redrawCanvas = useRef<() => void>(() => undefined);
  const [tool, setTool] = useState<DrawingTool>("pen");
  const [color, setColor] = useState<(typeof COLOR_PALETTE)[number]>(COLOR_PALETTE[0]);
  const [strokeWidth, setStrokeWidth] = useState(8);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const redraw = (): void => {
      const rect = canvas.getBoundingClientRect();
      const density = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * density));
      canvas.height = Math.max(1, Math.round(rect.height * density));
      const context = canvas.getContext("2d");
      if (context === null) return;
      context.setTransform(density, 0, 0, density, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      for (const stroke of props.strokes) drawStroke(context, stroke, rect.width, rect.height);
    };
    redrawCanvas.current = redraw;
    redraw();
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (redrawCanvas.current === redraw) redrawCanvas.current = () => undefined;
    };
  }, [props.strokes]);

  const drawLiveSegment = (stroke: ColoringStroke): void => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const density = Math.min(2, window.devicePixelRatio || 1);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(density, 0, 0, density, 0, 0);
    drawStroke(context, stroke, rect.width, rect.height);
  };

  const pointFor = (event: React.PointerEvent<HTMLCanvasElement>): Readonly<{ x: number; y: number }> => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  };

  const tracedArtwork = props.scene === "garden";

  return (
    <article className="coloring-book-card" aria-label={props.title}>
      <div className="coloring-book-toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="coloring-tool-toggle" role="group" aria-label="Drawing mode">
          <button type="button" aria-pressed={tool === "pen"} disabled={disabled} onClick={() => setTool("pen")}>Pen</button>
          <button type="button" aria-pressed={tool === "eraser"} disabled={disabled} onClick={() => setTool("eraser")}>Eraser</button>
        </div>
        <div className="coloring-palette" role="group" aria-label="Ink color">
          {COLOR_PALETTE.map((option) => (
            <button
              type="button"
              aria-label={`Use ${option} ink`}
              aria-pressed={color === option}
              disabled={disabled || tool === "eraser"}
              key={option}
              style={{ "--coloring-swatch": option } as React.CSSProperties}
              onClick={() => setColor(option)}
            />
          ))}
        </div>
        <label className="coloring-size-control">
          <span>Size</span>
          <input
            type="range"
            aria-label="Stroke size"
            disabled={disabled}
            min="3"
            max="20"
            step="1"
            value={strokeWidth}
            onChange={(event) => setStrokeWidth(Number(event.target.value))}
          />
        </label>
        <div className="coloring-history-controls">
          <button type="button" disabled={disabled || props.strokes.length === 0} onClick={() => void onEdit({ kind: "undo" })}>Undo</button>
          <button type="button" disabled={disabled || props.strokes.length === 0} onClick={() => void onEdit({ kind: "clear" })}>Clear</button>
        </div>
        <output className="visually-hidden" aria-live="polite">{props.strokes.length} stroke{props.strokes.length === 1 ? "" : "s"}</output>
      </div>

      <div className="coloring-scene" data-tool={tool}>
        <svg
          aria-hidden="true"
          data-traced-artwork={tracedArtwork || undefined}
          viewBox={tracedArtwork ? "0 0 1122 1402" : "0 0 720 650"}
          preserveAspectRatio={tracedArtwork ? "none" : "xMidYMid meet"}
        >
          {tracedArtwork
            ? <use href="/assets/coloring/child-forest-trace.svg#ink" />
            : sceneArtwork(props.scene)}
        </svg>
        <canvas
          ref={canvasRef}
          aria-label={`Draw on ${props.title}`}
          tabIndex={0}
          onPointerDown={(event) => {
            if (disabled || pointerId.current !== null) return;
            pointerId.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            const stroke: ColoringStroke = {
              id: `drawing:${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
              tool,
              color,
              width: tool === "eraser" ? strokeWidth * 1.7 : strokeWidth,
              points: [pointFor(event)],
            };
            activeStroke.current = stroke;
            drawLiveSegment(stroke);
          }}
          onPointerMove={(event) => {
            if (pointerId.current !== event.pointerId) return;
            const current = activeStroke.current;
            if (current === null || current.points.length >= 900) return;
            const point = pointFor(event);
            const previous = current.points[current.points.length - 1];
            const next = { ...current, points: [...current.points, point] };
            activeStroke.current = next;
            if (previous !== undefined) drawLiveSegment({ ...next, points: [previous, point] });
          }}
          onPointerUp={(event) => {
            if (pointerId.current !== event.pointerId) return;
            pointerId.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
            const completed = activeStroke.current;
            activeStroke.current = null;
            if (completed !== null) {
              void onEdit({ kind: "append", stroke: completed }).then((saved) => {
                if (!saved) redrawCanvas.current();
              });
            }
          }}
          onPointerCancel={() => {
            pointerId.current = null;
            activeStroke.current = null;
            redrawCanvas.current();
          }}
        />
      </div>
    </article>
  );
}
