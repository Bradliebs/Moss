import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeMandatoryCriterionCoverage,
  detectWorkspaceVerificationChecks,
  type VerificationCheck,
  type VerificationEvidence,
  VerificationRegistry,
} from "./verification-registry";

let workspaceRoot: string;
let server: Server | undefined;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "moss-verification-registry-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const live = (): AbortSignal => new AbortController().signal;
const check = (value: Partial<VerificationCheck> & Pick<VerificationCheck, "kind">): VerificationCheck => ({
  id: "check-1",
  criterionId: "criterion-1",
  ...value,
});

describe("VerificationRegistry", () => {
  it("runs command checks through the existing verifier", async () => {
    const evidence = await new VerificationRegistry().runChecks(
      [check({ kind: "command", command: "echo registry-marker" })],
      workspaceRoot,
      live(),
    );

    expect(evidence[0]).toMatchObject({ ok: true, kind: "command", checkId: "check-1" });
    expect(evidence[0].details).toContain("registry-marker");
  });

  it("checks file existence and content inside the workspace", async () => {
    writeFileSync(join(workspaceRoot, "result.txt"), "structured evidence", "utf8");
    const evidence = await new VerificationRegistry().runChecks(
      [
        check({ id: "exists", kind: "file-exists", path: "result.txt" }),
        check({ id: "contains", kind: "file-contains", path: "result.txt", substring: "evidence" }),
      ],
      workspaceRoot,
      live(),
    );

    expect(evidence.map((item) => item.ok)).toEqual([true, true]);
  });

  it("rejects file checks that escape the workspace", async () => {
    const outside = join(workspaceRoot, "..", `outside-${Date.now()}.txt`);
    writeFileSync(outside, "secret", "utf8");
    try {
      const evidence = await new VerificationRegistry().runChecks(
        [check({ kind: "file-contains", path: outside, substring: "secret" })],
        workspaceRoot,
        live(),
      );
      expect(evidence[0]).toMatchObject({ ok: false, summary: "Verification check failed", failureKind: "grader" });
      expect(evidence[0].details).toContain("escapes the workspace sandbox");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("rejects symlink targets outside the workspace when supported", async () => {
    const outside = mkdtempSync(join(tmpdir(), "moss-verification-outside-"));
    writeFileSync(join(outside, "secret.txt"), "secret", "utf8");
    try {
      try {
        symlinkSync(join(outside, "secret.txt"), join(workspaceRoot, "link.txt"), "file");
      } catch {
        return;
      }
      const evidence = await new VerificationRegistry().runChecks(
        [check({ kind: "file-exists", path: "link.txt" })],
        workspaceRoot,
        live(),
      );
      expect(evidence[0].ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("checks a running process without mutating it", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const evidence = await new VerificationRegistry().runChecks(
      [check({ kind: "process-running", pid: 4242 })],
      workspaceRoot,
      live(),
    );

    expect(kill).toHaveBeenCalledWith(4242, 0);
    expect(evidence[0].ok).toBe(true);
  });

  it("checks HTTP method, status, and body content", async () => {
    server = createServer((request, response) => {
      response.writeHead(request.method === "POST" ? 201 : 405, { "content-type": "text/plain" });
      response.end("receipt accepted");
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const evidence = await new VerificationRegistry().runChecks(
      [check({
        kind: "http",
        url: `http://127.0.0.1:${address.port}`,
        method: "POST",
        expectedStatus: 201,
        bodyIncludes: "accepted",
      })],
      workspaceRoot,
      live(),
    );

    expect(evidence[0]).toMatchObject({ ok: true, summary: "HTTP 201 matched expectations" });
  });

  it("folds HTTP timeouts into failed evidence", async () => {
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const evidence = await new VerificationRegistry().runChecks(
      [check({ kind: "http", url: `http://127.0.0.1:${address.port}`, timeoutMs: 10 })],
      workspaceRoot,
      live(),
    );

    expect(evidence[0]).toMatchObject({
      ok: false,
      summary: "HTTP verification could not reach the target",
      failureKind: "environment",
    });
  });

  it("aborts an in-flight HTTP check with the parent signal", async () => {
    const controller = new AbortController();
    server = createServer(() => controller.abort());
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const evidence = await new VerificationRegistry().runChecks(
      [check({ kind: "http", url: `http://127.0.0.1:${address.port}` })],
      workspaceRoot,
      controller.signal,
    );

    expect(evidence[0]).toMatchObject({ ok: false, summary: "Verification aborted", failureKind: "orchestration" });
  });

  it("records manual or external receipt assertions", async () => {
    const evidence = await new VerificationRegistry().runChecks(
      [check({ kind: "receipt", asserted: true, source: "manual", receipt: "approved by operator" })],
      workspaceRoot,
      live(),
    );

    expect(evidence[0]).toMatchObject({ ok: true, summary: "manual receipt asserted", details: "approved by operator" });
  });

  it("rejects duplicate handlers", () => {
    const registry = new VerificationRegistry(false);
    registry.register("custom", async () => ({ ok: true, summary: "ok" }));
    expect(() => registry.register("custom", async () => ({ ok: true, summary: "ok" }))).toThrow(
      "Verification handler already registered: custom",
    );
  });

  it("returns failed evidence for unknown kinds and thrown handlers", async () => {
    const registry = new VerificationRegistry(false);
    registry.register("throws", async () => {
      throw new Error("handler failure");
    });
    const evidence = await registry.runChecks(
      [check({ id: "unknown", kind: "unknown" }), check({ id: "throws", kind: "throws" })],
      workspaceRoot,
      live(),
    );

    expect(evidence[0]).toMatchObject({ ok: false, summary: "Unknown verification kind: unknown" });
    expect(evidence[1]).toMatchObject({ ok: false, details: "handler failure" });
  });

  it("honors an already-aborted parent signal for every check", async () => {
    const controller = new AbortController();
    controller.abort();
    const evidence = await new VerificationRegistry().runChecks(
      [check({ id: "first", kind: "command", command: "exit 0" }), check({ id: "second", kind: "receipt", asserted: true })],
      workspaceRoot,
      controller.signal,
    );

    expect(evidence).toHaveLength(2);
    expect(evidence.every((item) => !item.ok && item.summary === "Verification aborted")).toBe(true);
  });
});

describe("computeMandatoryCriterionCoverage", () => {
  it("uses the newest evidence for each required check", () => {
    const base = { criterionId: "criterion-1", checkId: "check-1", kind: "command", summary: "result" };
    const evidence: VerificationEvidence[] = [
      { ...base, ok: true, timestamp: "2026-01-01T00:00:00.000Z" },
      { ...base, ok: false, timestamp: "2026-01-02T00:00:00.000Z" },
    ];

    const coverage = computeMandatoryCriterionCoverage(
      [{ id: "criterion-1", description: "must pass", mandatory: true, checkIds: ["check-1"] }],
      evidence,
    );

    expect(coverage.complete).toBe(false);
    expect(coverage.criteria[0].failingCheckIds).toEqual(["check-1"]);
  });
});

describe("detectWorkspaceVerificationChecks", () => {
  it("proposes only existing scripts in typecheck, test, build order", async () => {
    writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({
      scripts: { build: "vite build", lint: "eslint .", test: "vitest", typecheck: "tsc --noEmit" },
    }));

    const checks = await detectWorkspaceVerificationChecks(workspaceRoot);

    expect(checks.map((item) => item.command)).toEqual(["npm run typecheck", "npm run test", "npm run build"]);
  });

  it("does not invent commands when scripts are absent", async () => {
    writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
    await expect(detectWorkspaceVerificationChecks(workspaceRoot)).resolves.toEqual([]);
  });

  it("returns no proposals when package.json is absent", async () => {
    await expect(detectWorkspaceVerificationChecks(workspaceRoot)).resolves.toEqual([]);
  });
});