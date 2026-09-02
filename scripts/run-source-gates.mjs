import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const includeBuild = process.argv.includes("--build");

const gates = [
  {
    name: "lint",
    entry: "node_modules/eslint/bin/eslint.js",
    args: ["src", "tests", "scripts"],
  },
  {
    name: "typecheck",
    entry: "node_modules/typescript/bin/tsc",
    args: ["--noEmit", "--incremental", "false"],
  },
  {
    name: "unit",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run"],
  },
];

if (includeBuild) {
  gates.push({
    name: "build",
    entry: "node_modules/next/dist/bin/next",
    args: ["build", "--webpack"],
  });
}

const results = [];

for (const gate of gates) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [resolve(root, gate.entry), ...gate.args], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const status = result.status ?? 1;

  results.push({
    gate: gate.name,
    status,
    durationMs: Date.now() - startedAt,
  });

  process.stdout.write(`${output}\n`);
  process.stdout.write(`${gate.name}: ${status === 0 ? "PASS" : "FAIL"}\n`);

  if (status !== 0) {
    process.stdout.write(`${JSON.stringify(results)}\n`);
    process.exit(status);
  }
}

process.stdout.write(`${JSON.stringify(results)}\n`);
