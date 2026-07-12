import { describe, expect, it } from "vitest";

import type { Tool } from "../tools/types";
import { CapabilityRegistry, normalizeCapability } from "./capability-registry";

function tool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object" },
    async execute() {
      return { ok: true, content: "ok" };
    },
  };
}

describe("CapabilityRegistry", () => {
  it("normalizes defaults for built-in and external tool adapters", () => {
    const builtIn = normalizeCapability({ tool: tool("read_file"), source: "built-in", tags: ["Files", "files"] });
    const external = normalizeCapability({
      tool: tool("mcp__mail__send"),
      source: "mcp",
      supportedPlatforms: ["win32"],
      requiredCredentials: ["MAIL_TOKEN"],
    });

    expect(builtIn).toMatchObject({
      id: "built-in:read_file",
      toolName: "read_file",
      risk: "readonly",
      health: "healthy",
      history: { successCount: 0, failureCount: 0 },
      estimatedCostUsd: 0,
      tags: ["files"],
    });
    expect(external).toMatchObject({
      source: "mcp",
      risk: "mutating",
      supportedPlatforms: ["win32"],
      requiredCredentials: ["MAIL_TOKEN"],
    });
  });

  it("registers, gets, lists, and unregisters capabilities", () => {
    const registry = new CapabilityRegistry();
    registry.register({ tool: tool("second"), source: "generated", id: "cap-b" });
    registry.register({ tool: tool("first"), source: "browser", id: "cap-a" });

    expect(registry.get(" CAP-A ")?.toolName).toBe("first");
    expect(registry.list().map((capability) => capability.id)).toEqual(["cap-a", "cap-b"]);
    expect(registry.unregister("CAP-A")).toBe(true);
    expect(registry.get("cap-a")).toBeUndefined();
    expect(registry.unregister("cap-a")).toBe(false);
  });

  it("rejects ambiguous duplicate ids regardless of case", () => {
    const registry = new CapabilityRegistry([{ tool: tool("one"), source: "built-in", id: "Shared" }]);

    expect(() => registry.register({ tool: tool("two"), source: "mcp", id: "shared" })).toThrow(
      "already registered",
    );
  });

  it("does not expose mutable metadata owned by the registry", () => {
    const registry = new CapabilityRegistry([
      { tool: tool("read_file"), source: "built-in", id: "files", tags: ["workspace"] },
    ]);

    const fetched = registry.get("files");
    fetched?.tags.push("changed");
    expect(registry.get("files")?.tags).toEqual(["workspace"]);
  });
});