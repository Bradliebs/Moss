import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CandidateLesson } from "./retrospective";
import { LessonStore } from "./lesson-store";

function candidate(overrides: Partial<CandidateLesson> = {}): CandidateLesson {
  return {
    id: "candidate-1",
    provenanceTaskId: "task-1",
    confidence: 0.6667,
    scope: "code repair",
    outcome: "positive",
    summary: "Run focused tests after editing",
    capabilityIds: ["workspace", "shell"],
    successCount: 1,
    failureCount: 0,
    rolledBack: false,
    ...overrides,
  };
}

describe("LessonStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-lessons-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists lessons under learning/lessons.json", async () => {
    const store = new LessonStore(dir);
    const [lesson] = await store.merge([candidate()]);
    const reopened = new LessonStore(dir);

    expect(await reopened.list()).toEqual([lesson]);
    expect(JSON.parse(readFileSync(join(dir, "learning", "lessons.json"), "utf8"))).toEqual([lesson]);
  });

  it("merges normalized fingerprints, updates outcome, confidence, version, and bounded provenance", async () => {
    const store = new LessonStore(dir);
    const [created] = await store.merge([candidate()]);
    const provenance = Array.from({ length: 55 }, (_, index) => `task-${index + 2}`);
    for (const provenanceTaskId of provenance) {
      await store.merge([candidate({
        provenanceTaskId,
        scope: " CODE   REPAIR ",
        summary: "run focused tests AFTER editing",
        capabilityIds: ["shell", "workspace", "shell"],
        outcome: "negative",
        successCount: 0,
        failureCount: 1,
      })]);
    }

    const [lesson] = await store.list();
    expect(lesson.id).toBe(created.id);
    expect(lesson.fingerprint).toBe(created.id);
    expect(lesson.version).toBe(56);
    expect(lesson.outcome).toBe("negative");
    expect(lesson.successCount).toBe(1);
    expect(lesson.failureCount).toBe(55);
    expect(lesson.confidence).toBe(0.0345);
    expect(lesson.provenanceTaskIds).toHaveLength(50);
    expect(lesson.provenanceTaskIds.at(-1)).toBe("task-56");
  });

  it("automatically rolls lessons back after repeated failures", async () => {
    const store = new LessonStore(dir);
    await store.merge([candidate({ outcome: "negative", successCount: 0, failureCount: 1 })]);
    const [lesson] = await store.merge([candidate({
      provenanceTaskId: "task-2",
      outcome: "negative",
      successCount: 0,
      failureCount: 1,
    })]);

    expect(lesson).toMatchObject({ successCount: 0, failureCount: 2, confidence: 0.25, rolledBack: true });
  });

  it("aggregates capability history and excludes rolled-back successes", async () => {
    const store = new LessonStore(dir);
    await store.merge([candidate({ capabilityIds: ["shell", "workspace"], successCount: 3 })]);
    await store.merge([candidate({
      provenanceTaskId: "task-2",
      summary: "Avoid a flaky command",
      capabilityIds: ["shell"],
      outcome: "negative",
      successCount: 1,
      failureCount: 3,
    })]);

    expect(await store.capabilityHistory()).toEqual(new Map([
      ["shell", { successCount: 3, failureCount: 3 }],
      ["workspace", { successCount: 3, failureCount: 0 }],
    ]));
  });

  it("filters malformed entries and recovers from corrupt JSON", async () => {
    const store = new LessonStore(dir);
    const [valid] = await store.merge([candidate()]);
    const path = join(dir, "learning", "lessons.json");
    writeFileSync(path, JSON.stringify([valid, { id: "malformed", summary: "unsafe" }]), "utf8");
    expect(await store.list()).toEqual([valid]);

    writeFileSync(path, "{not-json", "utf8");
    expect(await store.list()).toEqual([]);
    await store.merge([candidate({ provenanceTaskId: "recovered-task" })]);
    expect(await store.list()).toHaveLength(1);
  });

  it("serializes concurrent merges without losing observations", async () => {
    const store = new LessonStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.merge([candidate({ provenanceTaskId: `task-${index}` })])));

    expect(await store.list()).toMatchObject([{
      version: 20,
      successCount: 20,
      failureCount: 0,
    }]);
  });

  it("supersedes lessons with validation and omits superseded history", async () => {
    const store = new LessonStore(dir);
    const [original] = await store.merge([candidate()]);
    const [replacement] = await store.merge([candidate({ summary: "Use the replacement procedure", capabilityIds: ["browser"] })]);

    const superseded = await store.supersede(original.id, replacement.id);
    expect(superseded).toMatchObject({ supersededBy: replacement.id, version: 2 });
    expect(await store.capabilityHistory()).toEqual(new Map([["browser", { successCount: 1, failureCount: 0 }]]));
    await expect(store.supersede(replacement.id, replacement.id)).rejects.toThrow("cannot supersede itself");
    await expect(store.supersede("0".repeat(64), replacement.id)).rejects.toThrow("does not exist");
  });

  it("supports explicit manual rollback", async () => {
    const store = new LessonStore(dir);
    const [created] = await store.merge([candidate()]);
    const rolledBack = await store.rollback(created.id);

    expect(rolledBack).toMatchObject({ rolledBack: true, version: 2 });
    expect(await store.capabilityHistory()).toEqual(new Map([
      ["shell", { successCount: 0, failureCount: 0 }],
      ["workspace", { successCount: 0, failureCount: 0 }],
    ]));
  });
});