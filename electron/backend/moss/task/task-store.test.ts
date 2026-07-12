// electron/backend/moss/task/task-store.test.ts

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskSpec } from "../../../../common/types";
import { TaskStore } from "./task-store";

const SPEC: TaskSpec = {
  objective: "Finish the requested work",
  acceptanceCriteria: [{ id: "criterion-1", description: "Checks pass", mandatory: true }],
  constraints: ["Stay inside the workspace"],
  assumptions: [],
};

describe("TaskStore", () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-tasks-"));
    store = new TaskStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates and reloads a durable task snapshot", async () => {
    const created = await store.create(SPEC, "task-1");

    expect(created.state).toBe("intake");
    expect(created.revision).toBe(0);
    expect(await new TaskStore(dir).get("task-1")).toEqual(created);
  });

  it("rejects task ids that could escape or alias the task directory", async () => {
    for (const id of [".", "..", "../outside", "nested/task", " task", ""]) {
      await expect(store.create(SPEC, id)).rejects.toThrow("Task id must start");
    }
  });

  it("persists valid transitions and rejects invalid transitions", async () => {
    await store.create(SPEC, "task-1");
    const planning = await store.transition("task-1", "planning");
    const executing = await store.transition("task-1", "executing", { expectedRevision: planning.revision });

    expect(executing.state).toBe("executing");
    expect(executing.revision).toBe(2);
    await expect(store.transition("task-1", "completed")).rejects.toThrow(
      "Invalid task transition: executing -> completed",
    );
  });

  it("detects stale revision updates", async () => {
    await store.create(SPEC, "task-1");
    await store.transition("task-1", "planning", { expectedRevision: 0 });

    await expect(
      store.update("task-1", (task) => ({ ...task, spec: { ...task.spec, assumptions: ["new"] } }), 0),
    ).rejects.toThrow("revision conflict");
  });

  it("serializes concurrent updates without losing either change", async () => {
    await store.create(SPEC, "task-1");

    await Promise.all([
      store.update("task-1", (task) => ({
        ...task,
        spec: { ...task.spec, assumptions: [...task.spec.assumptions, "first"] },
      })),
      store.update("task-1", (task) => ({
        ...task,
        spec: { ...task.spec, assumptions: [...task.spec.assumptions, "second"] },
      })),
    ]);

    const task = await store.get("task-1");
    expect(task?.spec.assumptions).toEqual(["first", "second"]);
    expect(task?.revision).toBe(2);
  });

  it("recovers the latest state from the journal when the snapshot is corrupt", async () => {
    await store.create(SPEC, "task-1");
    await store.transition("task-1", "planning");
    writeFileSync(join(dir, "tasks", "task-1", "snapshot.json"), "{broken", "utf8");

    const recovered = await new TaskStore(dir).get("task-1");
    expect(recovered?.state).toBe("planning");
    expect(recovered?.revision).toBe(1);
  });

  it("ignores a partial final journal event during recovery", async () => {
    await store.create(SPEC, "task-1");
    const journal = join(dir, "tasks", "task-1", "events.jsonl");
    writeFileSync(journal, `${readFileSync(journal, "utf8")}{partial`, "utf8");
    writeFileSync(join(dir, "tasks", "task-1", "snapshot.json"), "invalid", "utf8");

    expect((await new TaskStore(dir).get("task-1"))?.revision).toBe(0);
  });

  it("lists newest tasks first and deletes task data", async () => {
    await store.create(SPEC, "task-1");
    await store.create(SPEC, "task-2");
    await store.update("task-1", (task) => ({ ...task, spec: { ...task.spec, assumptions: ["newest"] } }));

    expect((await store.list()).map((task) => task.id)).toEqual(["task-1", "task-2"]);
    await store.delete("task-1");
    expect(await store.get("task-1")).toBeNull();
  });
});