"use client";

import { useSyncExternalStore } from "react";

import type { PageCommandRegistry } from "../page";
import type { DemoSessionContext } from "./session-runtime";

export function DemoWebMcpPlayground({
  registry,
  session,
  agentConnection,
}: Readonly<{
  registry: PageCommandRegistry;
  session: DemoSessionContext;
  agentConnection: string;
}>): React.JSX.Element {
  const context = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const pageTools = registry.describe("webmcp");
  const writeToolCount = pageTools.filter((tool) => !tool.readOnly).length;
  const usage = session.pageStorage.getUsage();
  const connected = agentConnection === "Page conversation is ready.";

  return (
    <section className="demo-playground-panel" aria-label="WebMCP playground" data-webmcp-status={connected ? "connected" : "connecting"}>
      <div className="demo-playground-summary">
        <strong>{connected ? "WebMCP connected" : "Connecting WebMCP..."}</strong>
        <small>
          {pageTools.length} tools · {writeToolCount} actions · saved in this tab
        </small>
      </div>
      <details className="demo-tool-boundary">
        <summary>Details</summary>
        <div className="demo-tool-boundary-popover">
          <p role="status">
            Changes apply immediately. Page {context.pageRevision}, document {context.documentRevision}. Exact Undo remains available for the latest compatible change.
          </p>
          <p>
            Inputs, revisions, page targets, file types, and size limits are checked. Arbitrary code and unapproved external access stay outside the playground.
          </p>
          <p>{usage.appliedChanges} of {usage.appliedChangesLimit} session changes used. Bundled assets remain available in this tab.</p>
        </div>
      </details>
    </section>
  );
}
