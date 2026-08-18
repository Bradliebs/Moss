import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RunJournal,
  deriveFailureSignature,
  sanitizeForJournal,
  type TerminalRunRecordInput,
} from "./run-journal";

function record(overrides: Partial<TerminalRunRecordInput> = {}): TerminalRunRecordInput {
  return {
    taskId: "task-1",
    objectiveClass: "code-repair",
    capabilityIds: ["shell", "workspace"],
    attempts: [{ capabilityId: "shell", attempt: 1, result: "failed", summary: "test failed" }],
    failures: [{ category: "verification", summary: "one assertion failed" }],
    recoveryChoices: ["repair assertion"],
    criteria: [{ criterionId: "tests", passed: false, summary: "tests did not pass" }],
    outcome: "failed",
    durationMs: 1200,
    costUsd: 0.02,
    userSignals: [],
    ...overrides,
  };
}

describe("RunJournal", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-journal-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["completed", "failed", "blocked", "cancelled"] as const)("persists terminal %s runs", async (outcome) => {
    const journal = new RunJournal(dir);
    await journal.append(record({ outcome }));
    expect(await journal.read("task-1")).toMatchObject([{ taskId: "task-1", outcome }]);
  });

  it("recursively redacts sensitive keys and common credential values before writing", async () => {
    const journal = new RunJournal(dir);
    await journal.append(
      record({
        richArtifacts: {
          nested: { authorization: "Bearer visible-secret-value", harmless: "Bearer abcdefghijklmnop" },
          apiKey: "sk-this-should-never-persist",
          cookieJar: ["session=value"],
        },
      }),
      { retainRichArtifacts: true },
    );
    const persisted = readFileSync(join(dir, "learning", "runs", "task-1.json"), "utf8");
    expect(persisted).not.toContain("visible-secret-value");
    expect(persisted).not.toContain("sk-this-should-never-persist");
    expect(persisted).not.toContain("session=value");
    expect(persisted).toContain("[REDACTED]");
  });

  it("sanitizes arbitrary nested objects without mutating them", () => {
    const original = { child: { password: "private", note: "ok" } };
    expect(sanitizeForJournal(original)).toEqual({ child: { password: "[REDACTED]", note: "ok" } });
    expect(original.child.password).toBe("private");
  });

  it("serializes concurrent appends without losing records", async () => {
    const journal = new RunJournal(dir);
    await Promise.all([journal.append(record()), journal.append(record({ outcome: "blocked" }))]);
    expect(await journal.read("task-1")).toHaveLength(2);
  });

  it("lists records across task files", async () => {
    const journal = new RunJournal(dir);
    await journal.append(record());
    await journal.append(record({ taskId: "task-2", outcome: "completed" }));
    expect((await journal.list()).map((item) => item.taskId).sort()).toEqual(["task-1", "task-2"]);
  });

  it("derives stable mechanism, family, and verification signals", async () => {
    const journal = new RunJournal(dir);
    const first = await journal.append(record({
      failures: [{ category: "tool", capabilityId: "shell", summary: "Command failed after 12 ms at C:\\one\\file.ts" }],
    }));
    const second = await journal.append(record({
      failures: [{ category: "tool", capabilityId: "shell", summary: "Command failed after 99 ms at C:\\two\\file.ts" }],
    }));

    expect(first.schemaVersion).toBe(2);
    expect(first.failureSignatures).toEqual(second.failureSignatures);
    expect(first.taskFamilyCandidate.id).toMatch(/^code-repair-/);
    expect(first.verificationOutcomes).toHaveLength(1);
    expect(first.retention).toBe("sanitized");
  });

  it("uses reason codes as stable failure mechanisms", () => {
    expect(deriveFailureSignature({ category: "tool", reasonCode: "timeout", summary: "first" }))
      .toBe(deriveFailureSignature({ category: "tool", reasonCode: "timeout", summary: "different wording" }));
  });

  it("rejects richer local artifacts without explicit opt-in", async () => {
    const journal = new RunJournal(dir);
    await expect(journal.append(record({ richArtifacts: { transcript: "private" } })))
      .rejects.toThrow("explicit local retention opt-in");
  });
});