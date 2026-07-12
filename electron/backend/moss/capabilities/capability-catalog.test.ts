import { describe, expect, it } from "vitest";

import { CapabilityCatalog, validateCapabilityCatalog } from "./capability-catalog";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "example-tool",
    version: "1.2.3",
    sourceUrl: "https://example.test/tool.js",
    sha256: "a".repeat(64),
    platforms: ["win32", "linux"],
    runtime: "node",
    entry: { command: "node", args: ["artifact"] },
    permissions: ["network:example.test"],
    toolIds: ["example.search"],
    ...overrides,
  };
}

describe("capability catalog", () => {
  it("validates and returns platform-compatible cloned entries", () => {
    const catalog = new CapabilityCatalog({ schemaVersion: 1, entries: [entry()] });
    const listed = catalog.list("win32");
    expect(listed).toHaveLength(1);
    listed[0].entry.args.push("changed");
    expect(catalog.get("example-tool", "1.2.3")?.entry.args).toEqual(["artifact"]);
    expect(catalog.list("darwin")).toEqual([]);
  });

  it("rejects duplicate id and version pairs", () => {
    expect(() => validateCapabilityCatalog({ schemaVersion: 1, entries: [entry(), entry()] })).toThrow(
      "Duplicate catalog entry",
    );
  });

  it.each(["1.2", "^1.2.3", "latest", "1.2.x"])("rejects unpinned version %s", (version) => {
    expect(() => validateCapabilityCatalog({ schemaVersion: 1, entries: [entry({ version })] })).toThrow(
      "exact pinned semantic version",
    );
  });

  it.each(["http://example.test/tool", "ftp://example.test/tool", "not a url"])(
    "rejects unsafe source URL %s",
    (sourceUrl) => {
      expect(() => validateCapabilityCatalog({ schemaVersion: 1, entries: [entry({ sourceUrl })] })).toThrow();
    },
  );

  it("allows file URLs for local fixtures", () => {
    expect(
      validateCapabilityCatalog({ schemaVersion: 1, entries: [entry({ sourceUrl: "file:///tmp/tool.js" })] }),
    ).toBeDefined();
  });

  it.each(["A".repeat(64), "a".repeat(63), "g".repeat(64)])("rejects invalid sha256 %s", (sha256) => {
    expect(() => validateCapabilityCatalog({ schemaVersion: 1, entries: [entry({ sha256 })] })).toThrow(
      "64 lowercase hex",
    );
  });

  it("rejects unknown and missing fields at every level", () => {
    expect(() =>
      validateCapabilityCatalog({ schemaVersion: 1, entries: [entry({ surprise: true })] }),
    ).toThrow("unknown fields");
    expect(() =>
      validateCapabilityCatalog({
        schemaVersion: 1,
        entries: [entry({ entry: { command: "node", args: [], extra: true } })],
      }),
    ).toThrow("unknown fields");
    const missing = entry();
    delete missing.runtime;
    expect(() => validateCapabilityCatalog({ schemaVersion: 1, entries: [missing] })).toThrow("missing fields");
  });
});