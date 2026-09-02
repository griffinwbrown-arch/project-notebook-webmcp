import {
  vectorInkPaint,
  type VectorInkCommand,
  type VectorInkDocument,
} from "../../src/page";

export function createDetailedVectorInkFixture(): VectorInkDocument {
  const commands: VectorInkCommand[] = [{ kind: "move", x: 0, y: 0 }];
  for (let index = 1; index < 4_905; index += 1) {
    commands.push({
      kind: "line",
      x: (index * 37) % 670,
      y: (index * 19) % 154,
    });
  }
  return {
    version: 1,
    viewBox: { width: 670, height: 154 },
    paths: [{
      commands,
      paint: vectorInkPaint({
        stroke: "ink",
        strokeWidth: 2,
        fill: null,
        linecap: "round",
        linejoin: "round",
      }),
    }],
  };
}
