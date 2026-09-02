import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUIRED_FILES = [
  ".node-version",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "public/assets/anatomy/ATTRIBUTION.md",
  "public/assets/anatomy/authority-atlas-206.glb",
];
const BLOCKED_TRACKED_PATHS = [
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  /(^|\/)coverage\//,
  /(^|\/)tmp\//,
  /(^|\/)artifacts\//,
  /(^|\/)debug\.log$/,
  /(^|\/)\.env\.(?!example$)/,
  /\.(?:pem|key|p12|pfx)$/i,
];
const TEXT_RULES = [
  { id: "absolute-windows-user-path", pattern: /[A-Za-z]:\\Users\\[^\\\r\n]+/ },
  { id: "file-url", pattern: /file:\/\/\/(?:[A-Za-z]:|\/)/i },
  { id: "private-key", pattern: /BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY/ },
  { id: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: "openai-secret-key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
];
const EXPECTED_ATLAS_BYTES = 7_206_984;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { windowsHide: true });
const trackedFiles = stdout.split("\0").filter(Boolean);

for (const required of REQUIRED_FILES) {
  if (!trackedFiles.includes(required)) fail(`Missing tracked release file: ${required}`);
}

for (const file of trackedFiles) {
  if (BLOCKED_TRACKED_PATHS.some((pattern) => pattern.test(file))) {
    fail(`Blocked tracked path: ${file}`);
    continue;
  }
  const details = await stat(file);
  if (!details.isFile() || details.size > 2_000_000) continue;
  const bytes = await readFile(file);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) fail(`Release text rule ${rule.id} matched: ${file}`);
  }
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
for (const key of ["description", "license", "repository", "bugs", "homepage", "engines"]) {
  if (packageJson[key] === undefined) fail(`package.json is missing ${key}`);
}
if (packageJson.private !== true) fail("package.json must keep private: true");

const atlas = await stat("public/assets/anatomy/authority-atlas-206.glb");
if (atlas.size !== EXPECTED_ATLAS_BYTES) {
  fail(`The bundled anatomy atlas has ${atlas.size} bytes, expected ${EXPECTED_ATLAS_BYTES}`);
}

if (process.exitCode === undefined) {
  process.stdout.write(`Release audit passed for ${trackedFiles.length} tracked files.\n`);
}
