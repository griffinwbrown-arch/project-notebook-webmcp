import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "../../..");
const sourceRoot = resolve(appRoot, "src");
const removedDirectories = [
  resolve(sourceRoot, "app/api/realtime"),
  resolve(sourceRoot, "entries/realtime"),
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("removed GPT Realtime capability", () => {
  it("keeps the route, WebRTC client, credentials, and command source out of active code", () => {
    expect(removedDirectories.filter(existsSync).map((path) => relative(appRoot, path))).toEqual([]);

    const forbidden = /\b(?:gpt-realtime(?:-[\w.]+)?|realtime|webrtc|openai_api_key)\b/i;
    const violations = sourceFiles(sourceRoot)
      .filter((path) => forbidden.test(readFileSync(path, "utf8")))
      .map((path) => relative(appRoot, path));

    expect(violations).toEqual([]);
  });
});
