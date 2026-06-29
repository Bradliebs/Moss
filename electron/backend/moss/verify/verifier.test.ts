// electron/backend/moss/verify/verifier.test.ts
//
// Unit tests for the post-edit verification runner. Commands are run in a real
// temp directory via the shell using portable builtins (`exit`/`echo`) that
// behave the same under cmd.exe and POSIX sh, so the tests stay deterministic
// without depending on any external toolchain.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatVerifyReport, runVerify } from "./verifier";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "moss-verify-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const live = (): AbortSignal => new AbortController().signal;

describe("runVerify", () => {
  it("passes when every command exits zero", async () => {
    const result = await runVerify(["exit 0", "exit 0"], cwd, live());
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  it("stops at the first failing command (fail-fast)", async () => {
    const result = await runVerify(["exit 0", "exit 1", "exit 0"], cwd, live());
    expect(result.ok).toBe(false);
    // The third command never runs once the second fails.
    expect(result.results).toHaveLength(2);
    expect(result.results[0].ok).toBe(true);
    expect(result.results[1].ok).toBe(false);
  });

  it("ignores blank commands and yields an ok empty result", async () => {
    const result = await runVerify(["", "   "], cwd, live());
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it("captures command output", async () => {
    const result = await runVerify(["echo verify-marker"], cwd, live());
    expect(result.ok).toBe(true);
    expect(result.results[0].output).toContain("verify-marker");
  });

  it("runs nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runVerify(["exit 0"], cwd, controller.signal);
    expect(result.results).toHaveLength(0);
  });
});

describe("formatVerifyReport", () => {
  it("returns an empty string when no commands ran", () => {
    expect(formatVerifyReport({ ok: true, results: [] })).toBe("");
  });

  it("renders a PASS line without output", () => {
    const report = formatVerifyReport({
      ok: true,
      results: [{ command: "npm test", ok: true, output: "all good" }],
    });
    expect(report).toBe("[verification] PASS: npm test");
  });

  it("renders a FAIL line with the command output", () => {
    const report = formatVerifyReport({
      ok: false,
      results: [{ command: "npm test", ok: false, output: "1 failing" }],
    });
    expect(report).toBe("[verification] FAIL: npm test\n1 failing");
  });
});
