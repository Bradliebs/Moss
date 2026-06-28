// electron/backend/moss/mcp/mcp-config.test.ts
//
// Unit tests for the MCP config loader. The userData path (electron), the
// filesystem, and the logger are mocked, so these exercise the loader's own
// logic: seeding a disabled template on first run, validating entries, and
// never throwing on malformed input.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: vi.fn(() => "/userdata") } }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("../../../../common/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { readFileSync, writeFileSync } from "node:fs";

import { addMcpServer, ensureMcpConfig, loadMcpServers, removeMcpServer, setMcpServerEnabled, updateMcpServer } from "./mcp-config";

const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);

function missingFile() {
  mockRead.mockImplementation(() => {
    throw new Error("ENOENT");
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadMcpServers", () => {
  it("seeds a disabled template and returns an empty list when the file is missing", () => {
    missingFile();
    const servers = loadMcpServers();

    expect(servers).toEqual([]);
    expect(mockWrite).toHaveBeenCalledTimes(1);

    const written = mockWrite.mock.calls[0][1] as string;
    const template = JSON.parse(written);
    expect(Array.isArray(template)).toBe(true);
    expect(template).toContainEqual(
      expect.objectContaining({ id: "playwright", type: "stdio", enabled: false, command: "npx" }),
    );
    // Nothing in the seeded template is enabled.
    expect(template.every((e: { enabled?: boolean }) => e.enabled === false)).toBe(true);
  });

  it("returns valid configured servers without rewriting the file", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "a", command: "node" }]));
    const servers = loadMcpServers();

    expect(servers).toEqual([{ type: "stdio", id: "a", command: "node" }]);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON and returns an empty list", () => {
    mockRead.mockReturnValue("{ not valid json");
    expect(loadMcpServers()).toEqual([]);
  });

  it("rejects a non-array top-level value", () => {
    mockRead.mockReturnValue(JSON.stringify({ type: "stdio", id: "x", command: "node" }));
    expect(loadMcpServers()).toEqual([]);
  });

  it("filters out invalid entries while keeping valid ones", () => {
    mockRead.mockReturnValue(
      JSON.stringify([
        { type: "stdio", id: "ok", command: "node" },
        { type: "stdio", id: "nocmd" }, // invalid: stdio without command
        { type: "http", id: "h", url: "http://example.com" },
        { type: "stdio", id: "", command: "node" }, // invalid: empty id
        { type: "weird", id: "w" }, // invalid: unknown type
        "not-an-object", // invalid: not an object
      ]),
    );

    const servers = loadMcpServers();
    expect(servers.map((s) => s.id)).toEqual(["ok", "h"]);
  });
});

describe("ensureMcpConfig", () => {
  it("seeds the template and returns the config path when missing", () => {
    missingFile();
    const path = ensureMcpConfig();

    expect(path).toContain("mcp-servers.json");
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("returns the config path without rewriting when the file exists", () => {
    mockRead.mockReturnValue("[]");
    const path = ensureMcpConfig();

    expect(path).toContain("mcp-servers.json");
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("setMcpServerEnabled", () => {
  it("flips a server's enabled flag and rewrites the file", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "p", enabled: false, command: "npx" }]));

    expect(setMcpServerEnabled("p", true)).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWrite.mock.calls[0][1] as string);
    expect(written[0]).toMatchObject({ id: "p", enabled: true });
  });

  it("returns false without writing when the value is unchanged", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "p", enabled: false, command: "npx" }]));

    expect(setMcpServerEnabled("p", false)).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("returns false when the server id is not found", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "p", enabled: false, command: "npx" }]));

    expect(setMcpServerEnabled("missing", true)).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("returns false on a missing config file", () => {
    missingFile();
    expect(setMcpServerEnabled("p", true)).toBe(false);
  });
});

describe("addMcpServer", () => {
  const stdio = { type: "stdio" as const, id: "new", command: "node" };

  it("appends a valid server and rewrites the file", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "a", command: "npx" }]));

    expect(addMcpServer(stdio)).toBe(true);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockWrite.mock.calls[0][1] as string);
    expect(written.map((e: { id: string }) => e.id)).toEqual(["a", "new"]);
  });

  it("treats a missing file as an empty list so the first add still succeeds", () => {
    missingFile();

    expect(addMcpServer(stdio)).toBe(true);
    const written = JSON.parse(mockWrite.mock.calls[0][1] as string);
    expect(written).toEqual([stdio]);
  });

  it("refuses to add (and does not overwrite) when the existing file is malformed", () => {
    mockRead.mockReturnValue("{ not valid json");

    expect(addMcpServer(stdio)).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("rejects a duplicate id without writing", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "new", command: "npx" }]));

    expect(addMcpServer(stdio)).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("rejects an invalid config without writing", () => {
    expect(addMcpServer({ type: "stdio", id: "", command: "node" })).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("removeMcpServer", () => {
  it("drops a matching server and rewrites the file", () => {
    mockRead.mockReturnValue(
      JSON.stringify([
        { type: "stdio", id: "a", command: "npx" },
        { type: "stdio", id: "b", command: "node" },
      ]),
    );

    expect(removeMcpServer("a")).toBe(true);
    const written = JSON.parse(mockWrite.mock.calls[0][1] as string);
    expect(written.map((e: { id: string }) => e.id)).toEqual(["b"]);
  });

  it("returns false without writing when no entry matches", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "a", command: "npx" }]));

    expect(removeMcpServer("missing")).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("returns false on a missing config file", () => {
    missingFile();
    expect(removeMcpServer("a")).toBe(false);
  });
});

describe("updateMcpServer", () => {
  it("merges changed fields into the matching entry and preserves the rest", () => {
    mockRead.mockReturnValue(
      JSON.stringify([
        { type: "stdio", id: "a", command: "npx", args: ["old"], env: { TOKEN: "keep" }, enabled: true },
        { type: "stdio", id: "b", command: "node" },
      ]),
    );

    expect(updateMcpServer({ type: "stdio", id: "a", command: "npx", args: ["new"], enabled: true })).toBe(true);
    const written = JSON.parse(mockWrite.mock.calls[0][1] as string);
    expect(written[0]).toEqual({
      type: "stdio",
      id: "a",
      command: "npx",
      args: ["new"],
      env: { TOKEN: "keep" },
      enabled: true,
    });
    expect(written[1].id).toBe("b");
  });

  it("returns false without writing when no entry matches", () => {
    mockRead.mockReturnValue(JSON.stringify([{ type: "stdio", id: "a", command: "npx" }]));

    expect(updateMcpServer({ type: "stdio", id: "missing", command: "node" })).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("returns false on a missing config file", () => {
    missingFile();
    expect(updateMcpServer({ type: "stdio", id: "a", command: "node" })).toBe(false);
  });
});
