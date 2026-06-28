// electron/backend/moss/skills/skills-store.test.ts
//
// Unit tests for the on-disk skills store. A tmpdir baseDir override stands in
// for Electron userData, so `app` is never touched and no electron mock is
// needed (mirrors memory-store.test.ts).

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkillsStore } from "./skills-store";

describe("SkillsStore", () => {
  let dir: string;
  let store: SkillsStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-skills-"));
    store = new SkillsStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists nothing when the directory does not exist", () => {
    expect(store.list()).toEqual([]);
  });

  it("creates a skill and lists it back, enabled by default", () => {
    const created = store.create("Note Taker", "Takes notes", "Do the thing.");
    expect(created.id).toBe("note-taker");
    expect(created.name).toBe("note-taker");
    expect(created.description).toBe("Takes notes");
    expect(created.instructions).toBe("Do the thing.");
    expect(created.enabled).toBe(true);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("note-taker");
  });

  it("persists a created skill to disk across store instances", () => {
    store.create("Note Taker", "Takes notes", "Do the thing.");
    const reopened = new SkillsStore(dir);
    expect(reopened.list().map((s) => s.id)).toEqual(["note-taker"]);
  });

  it("slugifies a messy name into a filesystem-safe id", () => {
    const created = store.create("My Cool Skill!! v2", "desc", "body");
    expect(created.id).toBe("my-cool-skill-v2");
  });

  it("finds a skill by id or by name", () => {
    store.create("Finder", "finds", "body");
    expect(store.get("finder")?.id).toBe("finder");
    expect(store.get("nope")).toBeNull();
  });

  it("toggles enablement and persists it across instances", () => {
    store.create("Toggler", "t", "body");
    store.setEnabled("toggler", false);
    expect(store.list()[0].enabled).toBe(false);

    const reopened = new SkillsStore(dir);
    expect(reopened.list()[0].enabled).toBe(false);

    store.setEnabled("toggler", true);
    expect(store.list()[0].enabled).toBe(true);
  });

  it("deletes a skill and reports whether anything was removed", () => {
    store.create("Doomed", "d", "body");
    expect(store.delete("doomed")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.delete("doomed")).toBe(false);
  });

  it("updates description and instructions while preserving id and enablement", () => {
    store.create("Editable", "old desc", "old body");
    store.setEnabled("editable", false);

    const updated = store.update("editable", "new desc", "new body");
    expect(updated?.id).toBe("editable");
    expect(updated?.name).toBe("editable");
    expect(updated?.description).toBe("new desc");
    expect(updated?.instructions).toBe("new body");
    expect(updated?.enabled).toBe(false);

    const reopened = new SkillsStore(dir);
    const persisted = reopened.get("editable");
    expect(persisted?.description).toBe("new desc");
    expect(persisted?.instructions).toBe("new body");
  });

  it("returns null when updating a skill that does not exist", () => {
    expect(store.update("ghost", "d", "b")).toBeNull();
  });

  it("ignores directories without a SKILL.md file", () => {
    mkdirSync(join(dir, "m-skills", "not-a-skill"), { recursive: true });
    expect(store.list()).toEqual([]);
    expect(existsSync(join(dir, "m-skills", "not-a-skill"))).toBe(true);
  });
});
