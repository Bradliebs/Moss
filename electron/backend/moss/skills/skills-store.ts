// electron/backend/moss/skills/skills-store.ts
//
// Skills live on disk as <userData>/m-skills/<id>/SKILL.md. Enablement is tracked
// in <userData>/m-skills/disabled.json (a list of disabled ids). All reads are
// best-effort: a missing directory or unparsable file yields no skill rather than
// throwing.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";

import { app } from "electron";

import { createLogger } from "../../../../common/logger";
import type { Skill } from "../../../../common/types";
import { buildSkillMarkdown, parseSkillMarkdown, slugifySkillName } from "./skill-parse";

const log = createLogger("Skills");

export class SkillsStore {
  /** baseDir override exists for tests; production uses Electron userData. */
  constructor(private readonly baseDir?: string) {}

  private dir(): string {
    return join(this.baseDir ?? app.getPath("userData"), "m-skills");
  }

  private disabledFile(): string {
    return join(this.dir(), "disabled.json");
  }

  private loadDisabled(): Set<string> {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.disabledFile(), "utf8"));
      if (Array.isArray(raw)) return new Set(raw.filter((x): x is string => typeof x === "string"));
    } catch {
      /* missing or corrupt — treat as none disabled */
    }
    return new Set();
  }

  private saveDisabled(ids: Set<string>): void {
    try {
      mkdirSync(this.dir(), { recursive: true });
      writeFileSync(this.disabledFile(), `${JSON.stringify([...ids], null, 2)}\n`, "utf8");
    } catch (err) {
      log.error("failed to save disabled skills", err);
    }
  }

  list(): Skill[] {
    const dir = this.dir();
    if (!existsSync(dir)) return [];
    const disabled = this.loadDisabled();
    const skills: Skill[] = [];
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const file = join(dir, e.name, "SKILL.md");
      if (!existsSync(file)) continue;
      let parsed: ReturnType<typeof parseSkillMarkdown>;
      try {
        parsed = parseSkillMarkdown(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!parsed) continue;
      const id = e.name;
      skills.push({
        id,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        enabled: !disabled.has(id),
        createdAt: "",
        createdBy: parsed.createdBy === "agent" ? "agent" : "user",
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(nameOrId: string): Skill | null {
    return this.list().find((s) => s.name === nameOrId || s.id === nameOrId) ?? null;
  }

  create(name: string, description: string, instructions: string, createdBy?: "user" | "agent"): Skill {
    const slug = slugifySkillName(name) || "skill";
    const dir = join(this.dir(), basename(slug));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), buildSkillMarkdown(slug, description, instructions, createdBy), "utf8");
    const created = this.get(slug);
    if (!created) throw new Error(`failed to create skill '${slug}'`);
    return created;
  }

  /** Rewrite an existing skill's description and instructions in place. The id,
   *  name, and createdBy provenance are preserved; enablement is untouched.
   *  Returns the updated skill, or null when no skill with that id exists. */
  update(id: string, description: string, instructions: string): Skill | null {
    const file = join(this.dir(), basename(id), "SKILL.md");
    if (!existsSync(file)) return null;
    let parsed: ReturnType<typeof parseSkillMarkdown>;
    try {
      parsed = parseSkillMarkdown(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    if (!parsed) return null;
    writeFileSync(file, buildSkillMarkdown(parsed.name, description, instructions, parsed.createdBy), "utf8");
    return this.get(id);
  }

  /** Rename a skill: migrate its on-disk directory to the slug of the new name,
   *  preserving description, instructions, provenance, and enablement. Returns
   *  the renamed skill, null when the source is missing/unparsable, or the
   *  unchanged skill when the new name slugifies to the same id. Refuses to
   *  overwrite a different existing skill (returns null on a slug collision). */
  rename(id: string, newName: string): Skill | null {
    const oldDir = join(this.dir(), basename(id));
    const oldFile = join(oldDir, "SKILL.md");
    if (!existsSync(oldFile)) return null;
    let parsed: ReturnType<typeof parseSkillMarkdown>;
    try {
      parsed = parseSkillMarkdown(readFileSync(oldFile, "utf8"));
    } catch {
      return null;
    }
    if (!parsed) return null;
    const newId = slugifySkillName(newName) || "skill";
    if (newId === id) return this.get(id);
    const newDir = join(this.dir(), basename(newId));
    if (existsSync(newDir)) return null;
    mkdirSync(newDir, { recursive: true });
    writeFileSync(
      join(newDir, "SKILL.md"),
      buildSkillMarkdown(newId, parsed.description, parsed.instructions, parsed.createdBy),
      "utf8",
    );
    rmSync(oldDir, { recursive: true, force: true });
    const disabled = this.loadDisabled();
    if (disabled.delete(id)) {
      disabled.add(newId);
      this.saveDisabled(disabled);
    }
    return this.get(newId);
  }

  delete(id: string): boolean {
    const dir = join(this.dir(), basename(id));
    if (!existsSync(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    const disabled = this.loadDisabled();
    if (disabled.delete(id)) this.saveDisabled(disabled);
    return true;
  }

  setEnabled(id: string, enabled: boolean): void {
    const disabled = this.loadDisabled();
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.saveDisabled(disabled);
  }
}

export const skillsStore = new SkillsStore();
