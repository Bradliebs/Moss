import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { HarnessMatrixProgress, HarnessMatrixProgressStore } from "./matrix-runner";

export class FileHarnessMatrixProgressStore implements HarnessMatrixProgressStore {
  constructor(private readonly path: string) {}

  async load(): Promise<HarnessMatrixProgress | undefined> {
    if (!existsSync(this.path)) return undefined;
    const value: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    if (!isProgress(value)) throw new Error(`Invalid harness progress file: ${this.path}`);
    return value;
  }

  async save(progress: HarnessMatrixProgress): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
    try {
      renameSync(temporaryPath, this.path);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isProgress(value: unknown): value is HarnessMatrixProgress {
  return typeof value === "object"
    && value !== null
    && (value as { schemaVersion?: unknown }).schemaVersion === 1
    && typeof (value as { manifest?: unknown }).manifest === "object"
    && (value as { manifest?: unknown }).manifest !== null
    && Array.isArray((value as { cells?: unknown }).cells);
}
