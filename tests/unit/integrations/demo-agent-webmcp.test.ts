import { afterEach, describe, expect, it } from "vitest";

import { createNotebookId } from "../../../src/domain";
import { createDemoWorkspaceRuntime, type DemoWorkspaceRuntime } from "../../../src/demo/session-runtime";
import { bindDemoNotebookAgentSession, registerDemoDeskWebMcpTools } from "../../../src/demo/webmcp-workspace-tools";
import { createPageCommandRegistry } from "../../../src/page";
import type { WebMcpModelContext, WebMcpTool } from "../../../src/types/webmcp";

class CapturingModelContext implements WebMcpModelContext {
  public readonly tools = new Map<string, WebMcpTool>();
  public readonly registrations = new Map<string, number>();

  public registerTool(tool: WebMcpTool): void {
    this.registrations.set(tool.name, (this.registrations.get(tool.name) ?? 0) + 1);
    this.tools.set(tool.name, tool);
  }
}

describe("demo agent WebMCP", () => {
  let runtime: DemoWorkspaceRuntime | null = null;

  afterEach(async () => {
    await runtime?.cleanup();
    runtime = null;
  });

  it("registers exactly three strict tools once and executes through the live bound registry", async () => {
    runtime = createDemoWorkspaceRuntime();
    await runtime.controller.start();
    const inboxId = createNotebookId("demo-inbox");
    const opened = await runtime.controller.openNotebook(inboxId);
    if (!opened.ok) throw new Error(opened.issue.message);
    const context = new CapturingModelContext();

    await Promise.all([
      registerDemoDeskWebMcpTools(context, runtime.controller, runtime.session.pageStorage),
      registerDemoDeskWebMcpTools(context, runtime.controller, runtime.session.pageStorage),
    ]);
    expect([...context.tools.keys()]).toEqual(["notebook_read", "notebook_open", "notebook_apply"]);
    expect([...context.registrations.values()]).toEqual([1, 1, 1]);

    const first = await createPageCommandRegistry(runtime.session.pageStorage, inboxId);
    const releaseFirst = bindDemoNotebookAgentSession(context, inboxId, first, () => undefined);
    const apply = context.tools.get("notebook_apply");
    if (apply === undefined) throw new Error("notebook_apply was not registered.");
    await expect(apply.execute({ kind: "text.write", content: "Bound registry write" })).resolves.toMatchObject({ ok: true });
    await first.refresh();
    expect(first.getSnapshot().plainText).toBe("Bound registry write");

    const second = await createPageCommandRegistry(runtime.session.pageStorage, inboxId);
    await second.executeManual("page_advance", { mutationId: "agent-kernel-bind-page", expectedDocumentRevision: 1 });
    let viewResetCount = 0;
    const releaseSecond = bindDemoNotebookAgentSession(context, inboxId, second, () => { viewResetCount += 1; });
    releaseFirst();
    const open = context.tools.get("notebook_open");
    if (open === undefined) throw new Error("notebook_open was not registered.");
    await expect(open.execute({ kind: "relative-page", direction: "previous" })).resolves.toMatchObject({ ok: true, data: { page: 1 } });
    await expect(open.execute({ kind: "view.reset" })).resolves.toMatchObject({
      ok: true,
      data: { view: "reset", scale: 100, pan: { x: 0, y: 0 }, panEnabled: false },
    });
    expect(viewResetCount).toBe(1);

    const schemas = JSON.stringify([...context.tools.values()].map((tool) => tool.inputSchema));
    expect(schemas).toContain("layout.arrange");
    expect(schemas).toContain("diagram.arrange");
    expect(schemas).toContain("page.add");
    expect(schemas).toContain("view.reset");
    expect(schemas).toContain("figure.trace");
    expect(schemas).toContain("agent-guide");
    expect(schemas).toContain("sourceKind");
    expect(schemas).toContain("replaceTarget");
    expect(schemas).toContain("placement");
    for (const forbidden of ["expectedRevision", "claimId", "frame", "blockId", "mutationId", "receiptId"]) {
      expect(schemas).not.toContain(forbidden);
    }
    await expect(apply.execute({ kind: "undo", receiptId: "caller-controlled" })).resolves.toMatchObject({ ok: false, code: "INVALID_INPUT" });
    releaseSecond();
  });
});
