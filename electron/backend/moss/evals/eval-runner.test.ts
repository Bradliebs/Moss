import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvalCase, EvalExecutionObservation } from "../../../../common/evals";
import { collectEvalEvidence, type EvalExecutionResult, EvalRunner, scoreRun, validateCase } from "./eval-runner";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CASES: EvalCase[] = [
  {
    schemaVersion: 1,
    id: "coding-focused-fix",
    profile: "coding",
    difficulty: "smoke",
    task: {
      objective: "Fix the focused regression",
      acceptanceCriteria: [
        { id: "focused", description: "Focused test passes", mandatory: true },
        { id: "regression", description: "Existing tests still pass", mandatory: true },
      ],
      constraints: [],
      assumptions: [],
    },
    allowedCapabilities: ["read_file", "edit_file", "run_command"],
    checks: [
      { id: "focused-check", criterionId: "focused", kind: "receipt", asserted: true },
      { id: "regression-check", criterionId: "regression", kind: "receipt", asserted: true },
    ],
    repetitions: 2,
  },
  {
    schemaVersion: 1,
    id: "personal-browser-state",
    profile: "personal",
    difficulty: "standard",
    task: {
      objective: "Update the disposable browser fixture",
      acceptanceCriteria: [{ id: "state", description: "Expected state is visible", mandatory: true }],
      constraints: [],
      assumptions: [],
    },
    allowedCapabilities: ["browser"],
    checks: [{ id: "state-check", criterionId: "state", kind: "receipt", asserted: true }],
  },
];

function observation(testCase: EvalCase, repetition: number): EvalExecutionObservation {
  return {
    caseId: testCase.id,
    runId: `${testCase.id}-${repetition}`,
    provider: "test",
    model: "deterministic",
    outcome: "completed",
    startedAt: "2026-07-13T10:00:00.000Z",
    completedAt: "2026-07-13T10:00:02.000Z",
    evidence: testCase.task.acceptanceCriteria.map((criterion) => ({
      id: `${criterion.id}-${repetition}`,
      criterionId: criterion.id,
      kind: "command",
      passed: true,
      summary: `${criterion.description} verified`,
      capturedAt: "2026-07-13T10:00:01.000Z",
    })),
    usage: { inputTokens: 80, outputTokens: 20 },
    estimatedCostUsd: 0.01,
    admissions: ["attempted", "verified"],
  };
}

function execution(testCase: EvalCase, repetition: number): EvalExecutionResult {
  const { evidence, ...facts } = observation(testCase, repetition);
  return { workspaceRoot: "", observation: { ...facts, claimedEvidence: evidence } };
}

describe("EvalRunner", () => {
  it("runs repetitions and reports profile-specific metrics and admission flow", async () => {
    const execute = vi.fn(execution);
    const runner = new EvalRunner(execute, { now: () => new Date("2026-07-13T12:00:00.000Z") });

    const report = await runner.run(CASES);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(report.generatedAt).toBe("2026-07-13T12:00:00.000Z");
    expect(report.overall).toMatchObject({ runs: 3, successes: 3, successRate: 1, averageTokens: 100 });
    expect(report.overall.admissions).toMatchObject({ attempted: 3, verified: 3, blocked: 0 });
    expect(report.byProfile.coding).toMatchObject({ runs: 2, successes: 2 });
    expect(report.byProfile.personal).toMatchObject({ runs: 1, successes: 1 });
  });

  it("uses the newest evidence and requires every mandatory criterion", () => {
    const testCase = CASES[0];
    const result = scoreRun(testCase, {
      ...observation(testCase, 0),
      evidence: [
        ...observation(testCase, 0).evidence,
        {
          id: "focused-regressed",
          criterionId: "focused",
          kind: "command",
          passed: false,
          summary: "Focused test regressed",
          capturedAt: "2026-07-13T10:00:01.500Z",
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.score).toBe(0.5);
    expect(result.criteria[0]).toMatchObject({ passed: false, summary: "Focused test regressed" });
  });

  it("rejects cases that cannot establish verified success", () => {
    expect(() => validateCase({
      ...CASES[0],
      task: {
        ...CASES[0].task,
        acceptanceCriteria: [{ id: "optional", description: "Optional", mandatory: false }],
      },
    })).toThrow("mandatory acceptance criterion");
    expect(() => validateCase({ ...CASES[0], repetitions: 0 })).toThrow("positive integer");
    expect(() => validateCase({ ...CASES[0], checks: [] })).toThrow("has no independent check");
  });

  it("collects independent end-state evidence through the verification registry", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-eval-"));
    temporaryDirectories.push(workspaceRoot);
    writeFileSync(join(workspaceRoot, "result.txt"), "verified state", "utf8");
    const testCase: EvalCase = {
      ...CASES[1],
      checks: [{
        id: "state-check",
        criterionId: "state",
        kind: "file-contains",
        path: "result.txt",
        substring: "verified",
      }],
    };

    const evidence = await collectEvalEvidence(testCase, workspaceRoot, new AbortController().signal);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ criterionId: "state", kind: "file", passed: true });
    expect(evidence[0].summary).toContain("contains the expected text");
  });

  it("fails a completed run when claimed evidence passes but the independent grader fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "moss-eval-adversarial-"));
    temporaryDirectories.push(workspaceRoot);
    const testCase: EvalCase = {
      ...CASES[1],
      checks: [{
        id: "state-check",
        criterionId: "state",
        kind: "file-contains",
        path: "missing-result.txt",
        substring: "claimed success",
      }],
    };
    const execute = vi.fn(async (): Promise<EvalExecutionResult> => ({
      ...execution(testCase, 0),
      workspaceRoot,
    }));

    const report = await new EvalRunner(execute).run([testCase]);

    expect(report.results[0].success).toBe(false);
    expect(report.results[0].criteria[0]).toMatchObject({ passed: false });
    expect(report.results[0].observation.admissions).not.toContain("verified");
  });
});