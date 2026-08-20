import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ToolOutputStore } from "../context/tool-output-store";
import { createReadToolOutputTool } from "./tool-output-tool";

describe("read_tool_output", () => {
  let root: string;
  let store: ToolOutputStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "moss-tool-output-tool-"));
    store = new ToolOutputStore(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads bounded ranges and literal search matches", async () => {
    const record = await store.save({ callId: "c1", toolName: "read_file", external: false, content: "alpha\nneedle one\nomega\nneedle two" });
    const tool = createReadToolOutputTool(store);

    const range = await tool.execute({ id: record.id, offset: 6, limit: 10 }, { workspaceRoot: "", signal: new AbortController().signal });
    const search = await tool.execute({ id: record.id, query: "needle" }, { workspaceRoot: "", signal: new AbortController().signal });

    expect(range.content).toContain("needle one");
    expect(search.content).toContain("2: needle one");
    expect(search.content).toContain("4: needle two");
  });

  it("preserves the external-content boundary on retrieval", async () => {
    const record = await store.save({ callId: "c1", toolName: "fetch_url", external: true, content: "remote text" });
    const result = await createReadToolOutputTool(store).execute({ id: record.id }, { workspaceRoot: "", signal: new AbortController().signal });

    expect(result.content).toContain('<external_content source="fetch_url">');
    expect(result.content).toContain("remote text");
  });
});