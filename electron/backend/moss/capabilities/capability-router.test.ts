import { describe, expect, it } from "vitest";

import type { Tool } from "../tools/types";
import { CapabilityRegistry, type CapabilityRegistration } from "./capability-registry";
import { CapabilityRouter } from "./capability-router";

function registration(
  id: string,
  overrides: Partial<CapabilityRegistration> = {},
): CapabilityRegistration {
  const tool: Tool = {
    name: id,
    description: id,
    parameters: { type: "object" },
    async execute() {
      return { ok: true, content: "ok" };
    },
  };
  return { id, tool, source: "built-in", tags: ["workspace-edit"], ...overrides };
}

describe("CapabilityRouter", () => {
  it("ranks exact matches before tags, then lower risk and cost, then reliability", () => {
    const registry = new CapabilityRegistry([
      registration("tag-only", { risk: "mutating", estimatedCostUsd: 0, history: { successCount: 10, failureCount: 0 } }),
      registration("workspace-edit", { risk: "mutating", estimatedCostUsd: 5, history: { successCount: 1, failureCount: 9 } }),
      registration("lower-risk", { risk: "readonly", estimatedCostUsd: 4, history: { successCount: 1, failureCount: 0 } }),
      registration("lower-cost", { risk: "readonly", estimatedCostUsd: 1, history: { successCount: 1, failureCount: 1 } }),
      registration("reliable-b", { risk: "readonly", estimatedCostUsd: 1, history: { successCount: 9, failureCount: 1 } }),
      registration("reliable-a", { risk: "readonly", estimatedCostUsd: 1, history: { successCount: 9, failureCount: 1 } }),
    ]);

    const exact = new CapabilityRouter(registry).route({ capabilityNames: ["workspace-edit"] });
    expect(exact.selected[0].id).toBe("workspace-edit");

    registry.unregister("workspace-edit");
    const tagFallback = new CapabilityRouter(registry).route({ capabilityNames: ["workspace-edit"] });
    expect(tagFallback.selected[0].id).toBe("reliable-a");
  });

  it("is deterministic regardless of registration and requirement order", () => {
    const entries = [registration("beta"), registration("alpha")];
    const first = new CapabilityRouter(new CapabilityRegistry(entries)).route({
      requiredTags: ["workspace-edit", "WORKSPACE-EDIT"],
    });
    const second = new CapabilityRouter(new CapabilityRegistry([...entries].reverse())).route({
      requiredTags: ["WORKSPACE-EDIT", "workspace-edit"],
    });

    expect(first.selected.map((capability) => capability.id)).toEqual(["alpha"]);
    expect(second).toEqual(first);
  });

  it("filters unhealthy, unsupported, and credential-blocked capabilities", () => {
    const registry = new CapabilityRegistry([
      registration("unhealthy", { health: "unhealthy" }),
      registration("linux-only", { supportedPlatforms: ["linux"] }),
      registration("credentialed", { requiredCredentials: ["API_TOKEN"] }),
      registration("eligible", { supportedPlatforms: ["win32"], requiredCredentials: ["READY"] }),
    ]);

    const result = new CapabilityRouter(registry).route({
      requiredTags: ["workspace-edit"],
      platform: "win32",
      availableCredentials: ["READY"],
    });

    expect(result.selected.map((capability) => capability.id)).toEqual(["eligible"]);
    expect(result.unmet).toEqual([]);
  });

  it("returns explicit reasons for filtered and unknown requirements", () => {
    const registry = new CapabilityRegistry([
      registration("desktop-edit", {
        health: "degraded",
        supportedPlatforms: ["linux"],
        requiredCredentials: ["DESKTOP_TOKEN"],
        tags: ["desktop"],
      }),
    ]);

    const result = new CapabilityRouter(registry).route({
      requiredTags: ["desktop", "missing"],
      platform: "win32",
    });

    expect(result.selected).toEqual([]);
    expect(result.unmet).toHaveLength(2);
    expect(result.unmet.find((item) => item.requirement === "desktop")?.reasons.join(" ")).toContain("health is degraded");
    expect(result.unmet.find((item) => item.requirement === "desktop")?.reasons.join(" ")).toContain("platform win32");
    expect(result.unmet.find((item) => item.requirement === "desktop")?.reasons.join(" ")).toContain("DESKTOP_TOKEN");
    expect(result.unmet.find((item) => item.requirement === "missing")?.reasons).toEqual([
      "No registered capability matches this requirement",
    ]);
  });
});