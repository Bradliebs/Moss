import { describe, expect, it, vi } from "vitest";

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import type { EvalCase, EvalModelTarget, HarnessMatrixReport, HarnessVariant } from "../../../../common/evals";
import type { HarnessEvalConfig } from "./eval-cli";
import { runEvalCli } from "./eval-cli";

const testCase: EvalCase = {
  schemaVersion: 1,
  id: "cli-case",
  profile: "platform",
  difficulty: "smoke",
  task: {
    objective: "Validate the CLI config",
    acceptanceCriteria: [{ id: "valid", description: "Config is valid", mandatory: true }],
    constraints: [],
    assumptions: [],
  },
  allowedCapabilities: [],
  checks: [{ id: "valid-check", criterionId: "valid", kind: "receipt", asserted: true }],
  repetitions: 2,
};

const target: EvalModelTarget = {
  schemaVersion: 1,
  id: "cli-model",
  providerId: "fixture",
  providerKind: "deterministic",
  model: "fixture-model",
};

const variants: HarnessVariant[] = [
  { schemaVersion: 1, id: "one", description: "First" },
  { schemaVersion: 1, id: "two", description: "Second" },
];

describe("runEvalCli", () => {
  it("dry-runs a config without invoking its executor", async () => {
    const createExecutor = vi.fn();
    const config: HarnessEvalConfig = { cases: [testCase], targets: [target], variants, createExecutor };
    const stdout = vi.fn();

    const exitCode = await runEvalCli(["dry-run", "fixture.cjs"], {
      loadConfig: () => config,
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(createExecutor).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"cells": 4'));
  });

  it("returns a usage error for unknown commands", async () => {
    const stderr = vi.fn();

    const exitCode = await runEvalCli([], { io: { stdout: vi.fn(), stderr } });

    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage:"));
  });

  it("loads an explicit threshold policy for report diffs", async () => {
    const baseline = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;
    const loadThresholds = vi.fn(() => ({ maxTokenIncrease: 2_000 }));
    const stdout = vi.fn();

    const exitCode = await runEvalCli([
      "diff",
      "baseline.json",
      "candidate.json",
      "--policy",
      "reports/pilot-thresholds.json",
    ], {
      readReport: () => baseline,
      loadThresholds,
      io: { stdout, stderr: vi.fn() },
    });

    expect(exitCode).toBe(0);
    expect(loadThresholds).toHaveBeenCalledWith(resolve("reports/pilot-thresholds.json"));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"passed": true'));
  });

  it("rejects process thresholds outside the score delta range", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "moss-policy-"));
    const policyPath = resolve(root, "invalid.json");
    writeFileSync(policyPath, '{"minProcessDelta":-5}', "utf8");
    const baseline = JSON.parse(readFileSync(resolve("reports/pilot-baseline.json"), "utf8")) as HarnessMatrixReport;

    await expect(runEvalCli([
      "diff",
      "baseline.json",
      "candidate.json",
      "--policy",
      policyPath,
    ], {
      readReport: () => baseline,
      io: { stdout: vi.fn(), stderr: vi.fn() },
    })).rejects.toThrow("Invalid harness threshold policy");

    rmSync(root, { recursive: true, force: true });
  });
});