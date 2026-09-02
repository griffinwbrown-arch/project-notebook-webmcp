# Project: Notebook

Project: Notebook is an agent-controlled visual notebook built for the OpenAI WebMCP Challenge. A person can ask an agent to create and format notes, add pages, build diagrams, arrange figures, or move through a notebook without reproducing those actions by hand.

Live demo: [project-notebook-webmcp-demo.griffinbgardening.chatgpt.site](https://project-notebook-webmcp-demo.griffinbgardening.chatgpt.site/desk?notebook=instruction-notebook)

## What to try

- Open the Instruction Notebook and ask the agent to move to page 3.
- Ask for a new notebook with formatted notes and a simple flow diagram.
- Use the Calculus I notebook for practice, hints, and answer feedback.
- Rotate, isolate, and study the 206-part skeleton in Anatomy exam prep.
- Draw directly on the child-level coloring pages, then use Undo, Clear, Pan, zoom, or Reset.

The demo stores visitor changes in the browser session. It does not require an API key, account credential, or server-side notebook database.

## WebMCP implementation

The running desk registers three bounded tools:

| Tool | Purpose |
| --- | --- |
| `notebook_read` | Read the agent guide, shelf, current notebook, exact pages, and reversible receipts. |
| `notebook_open` | Open notebooks and pages, move to adjacent pages, return to the shelf, or reset the book view. |
| `notebook_apply` | Create notebooks, write formatted text, add pages and figures, arrange layouts, trace approved art, and undo. |

Production registration uses the browser's WebMCP API directly:

```ts
for (const tool of notebookTools) {
  await document.modelContext.registerTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
    execute: async (input) => tool.execute(input),
  });
}
```

The implementation is in [`src/demo/webmcp-workspace-tools.ts`](src/demo/webmcp-workspace-tools.ts). Input schemas are strict JSON Schemas. The notebook kernel validates external data, owns page placement and pagination, and returns structured results. Agents do not supply internal revisions, mutation IDs, receipts, or raw renderer records.

In ChatGPT's in-app browser, opening the desk exposes the registered tools automatically. The same tools can be tested in a WebMCP-enabled browser.

## Run locally

Requirements:

- Node.js 24, matching [`.node-version`](.node-version)
- pnpm 10

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:3211/desk`.

For the production build:

```powershell
pnpm build
pnpm start
```

For the ChatGPT Sites-compatible build:

```powershell
pnpm build:site
pnpm start:site
```

## Verify

```powershell
pnpm test
pnpm verify
pnpm audit:release
```

The test suite covers tool registration, strict schemas, navigation, writing, diagrams, drawing, Undo, persistence, and notebook activities. `audit:release` checks the Git-tracked release for blocked build output, local paths, private keys, and common secret formats.

## Data and safety boundaries

- Notebook data stays in the visitor's browser.
- WebMCP calls accept bounded task intent, not arbitrary JavaScript, HTML, URLs, or file paths.
- The app owns page IDs, revisions, placement, receipts, and exact Undo.
- The public repository excludes local deployment IDs, hackathon account state, generated builds, recordings, temporary traces, and internal agent instructions.

The anatomy model comes from Z-Anatomy and is redistributed under CC BY-SA 4.0. See [the anatomy attribution](public/assets/anatomy/ATTRIBUTION.md). Other third-party notices are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## License

Project: Notebook is released under the [MIT License](LICENSE). Third-party assets and dependencies retain their stated licenses.
