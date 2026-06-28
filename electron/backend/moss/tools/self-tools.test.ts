// Integration test for the self-management memory tools. Exercises the full
// remember -> list -> recall -> forget cycle against the process-wide memory
// store, verifying the tools' user-facing result strings. electron's userData
// path is redirected to a throwaway temp dir (via vi.hoisted, so the path exists
// before the electron mock factory runs) so the singleton store never touches
// real app data.

import { rmSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { tempDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return { tempDir: mkdtempSync(join(tmpdir(), "moss-self-")) };
});

vi.mock("electron", () => ({ app: { getPath: () => tempDir } }));

import { memoryStore } from "../memory/memory-store";
import { skillsStore } from "../skills/skills-store";
import {
  createSkillTool,
  deleteSkillTool,
  forgetTool,
  getSkillTool,
  listMemoriesTool,
  listSkillsTool,
  recallTool,
  rememberTool,
  updateSkillTool,
} from "./self-tools";

const ctx = { workspaceRoot: "", signal: new AbortController().signal };

beforeEach(() => {
  memoryStore.clear();
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("self-tools memory cycle", () => {
  it("remembers, lists, recalls, then forgets a fact", async () => {
    const remembered = await rememberTool.execute({ fact: "Moss prefers tabs", category: "preference" }, ctx);
    expect(remembered.ok).toBe(true);
    expect(remembered.content).toContain("Remembered (preference): Moss prefers tabs");

    const listed = await listMemoriesTool.execute({}, ctx);
    expect(listed.ok).toBe(true);
    expect(listed.content).toContain("Moss prefers tabs");

    const recalled = await recallTool.execute({ query: "tabs" }, ctx);
    expect(recalled.ok).toBe(true);
    expect(recalled.content).toContain("Moss prefers tabs");

    // recall renders "[category|id] fact"; pull the id back out to forget it.
    const id = recalled.content.match(/\[[^|]+\|([^\]]+)\]/)?.[1];
    expect(id).toBeTruthy();

    const forgotten = await forgetTool.execute({ id }, ctx);
    expect(forgotten.ok).toBe(true);
    expect(forgotten.content).toBe("Forgotten.");

    const afterForget = await listMemoriesTool.execute({}, ctx);
    expect(afterForget.content).toBe("No memories stored.");
  });

  it("reports empty results honestly", async () => {
    expect((await listMemoriesTool.execute({}, ctx)).content).toBe("No memories stored.");
    expect((await recallTool.execute({ query: "nothing" }, ctx)).content).toBe("No matching memories.");
    expect((await forgetTool.execute({ id: "does-not-exist" }, ctx)).ok).toBe(false);
  });
});

describe("self-tools skills introspection", () => {
  it("lists skills and loads one by name, hiding it once disabled", async () => {
    expect((await listSkillsTool.execute({}, ctx)).content).toBe("No skills available.");

    const skill = skillsStore.create("weather-lookup", "Look up the weather", "Step 1: ask for a city.");

    const listed = await listSkillsTool.execute({}, ctx);
    expect(listed.ok).toBe(true);
    expect(listed.content).toContain(`- ${skill.name}: Look up the weather`);

    const loaded = await getSkillTool.execute({ name: skill.name }, ctx);
    expect(loaded.ok).toBe(true);
    expect(loaded.content).toContain("Step 1: ask for a city.");

    // A disabled skill is invisible to both tools.
    skillsStore.setEnabled(skill.id, false);
    const afterDisable = await getSkillTool.execute({ name: skill.name }, ctx);
    expect(afterDisable.ok).toBe(false);
    expect((await listSkillsTool.execute({}, ctx)).content).toBe("No skills available.");

    skillsStore.delete(skill.id);
  });

  it("reports a missing skill honestly", async () => {
    const missing = await getSkillTool.execute({ name: "does-not-exist" }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain("does-not-exist");
  });
});

describe("self-tools skills authoring", () => {
  it("creates disabled and marked, refuses to clobber, updates in place, then deletes a skill", async () => {
    const created = await createSkillTool.execute(
      { name: "Deploy Helper", description: "Helps deploy", instructions: "Run the deploy script." },
      ctx,
    );
    expect(created.ok).toBe(true);
    expect(created.content).toContain("deploy-helper");
    expect(created.content).toContain("disabled");

    // agent-authored skills land disabled and marked, so they stay out of the
    // system prompt until a human enables them in the Library
    const stored = skillsStore.get("deploy-helper");
    expect(stored?.enabled).toBe(false);
    expect(stored?.createdBy).toBe("agent");

    // while disabled it is invisible to the model's enabled-only views
    expect((await listSkillsTool.execute({}, ctx)).content).toBe("No skills available.");
    expect((await getSkillTool.execute({ name: "deploy-helper" }, ctx)).ok).toBe(false);

    // creating the same skill again is refused even while disabled -- no silent overwrite
    const dup = await createSkillTool.execute({ name: "deploy-helper", description: "x", instructions: "y" }, ctx);
    expect(dup.ok).toBe(false);
    expect(dup.content).toContain("already exists");

    // a human enables it; now the model can see and load it
    skillsStore.setEnabled("deploy-helper", true);
    expect((await listSkillsTool.execute({}, ctx)).content).toContain("deploy-helper");
    expect((await getSkillTool.execute({ name: "deploy-helper" }, ctx)).content).toContain("Run the deploy script.");

    // update changes instructions while preserving enablement and the agent marker
    const updated = await updateSkillTool.execute(
      { name: "deploy-helper", instructions: "Run deploy.sh then verify." },
      ctx,
    );
    expect(updated.ok).toBe(true);
    expect((await getSkillTool.execute({ name: "deploy-helper" }, ctx)).content).toContain("Run deploy.sh then verify.");
    expect((await listSkillsTool.execute({}, ctx)).content).toContain("Helps deploy");
    const afterUpdate = skillsStore.get("deploy-helper");
    expect(afterUpdate?.enabled).toBe(true);
    expect(afterUpdate?.createdBy).toBe("agent");

    const deleted = await deleteSkillTool.execute({ name: "deploy-helper" }, ctx);
    expect(deleted.ok).toBe(true);
    expect((await listSkillsTool.execute({}, ctx)).content).toBe("No skills available.");
  });

  it("rejects authoring of unknown skills and empty updates", async () => {
    expect((await updateSkillTool.execute({ name: "ghost", instructions: "x" }, ctx)).ok).toBe(false);
    expect((await deleteSkillTool.execute({ name: "ghost" }, ctx)).ok).toBe(false);

    skillsStore.create("real-skill", "Real", "Body");
    const empty = await updateSkillTool.execute({ name: "real-skill" }, ctx);
    expect(empty.ok).toBe(false);
    expect(empty.content).toContain("Nothing to update");
    skillsStore.delete("real-skill");
  });
});
