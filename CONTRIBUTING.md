# Contributing

Project: Notebook accepts focused fixes and product changes that preserve its local-first authority model.

## Set up the project

Use the Node version in `.node-version` and the pnpm version in `package.json`.

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

Create a short-lived `feature/`, `fix/`, or `docs/` branch. Keep unrelated edits out of the pull request.

## Required checks

Run `pnpm verify` for every code change. Run `pnpm test:mutation:check` when executable source changes. Use the focused anatomy acceptance runner when work touches the verified skeleton, test flow, or coloring lab.

Public-release candidates must also pass `pnpm audit:release` from the exact tracked tree.

## Authority and WebMCP rules

- Keep `PageDocument` and app-owned storage as the saved authority.
- Parse external data at the boundary and reject unknown or stale input.
- Expose only bounded commands through WebMCP. Do not accept scripts, markup, file paths, remote URLs, renderer records, or arbitrary coordinates.
- Keep manual review for changes that require judgment. Preserve one exact receipt, revision, and Undo result.
- Add tests for failed and stale requests. A rejected request must leave canonical state unchanged.

## Assets and licenses

Only add assets with redistribution rights and a clear source record. Keep third-party license text and attribution beside redistributed material. The Z-Anatomy atlas is CC BY-SA 4.0.

By contributing project code, you agree that it may be distributed under the MIT License in `LICENSE`. Third-party material remains under its stated license.
