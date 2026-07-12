// electron/backend/moss/persistence/atomic-file.ts
//
// Crash-safe file writes: write to a unique temp file in the target directory,
// then rename it over the destination. On POSIX and Windows a rename is atomic
// within a filesystem, so a reader (or a crash) never observes a half-written
// file -- it sees either the old content or the new, never a truncated mix. The
// JSON stores (memory, skills, mcp-config, checkpoints) overwrite the same file
// repeatedly, where a partial write would corrupt durable state; routing those
// writes through here removes that failure mode. Best-effort temp cleanup on
// failure keeps stray `.tmp-*` files from accumulating.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

/** A collision-resistant sibling temp path so concurrent writers never share a
 *  temp file. Kept in the same directory as the target so the rename stays on
 *  one filesystem (a cross-device rename is not atomic and would throw EXDEV). */
function tempPath(path: string): string {
  return `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/** Synchronous atomic write. Creates parent directories as needed. Throws on a
 *  write/rename failure after removing the temp file, so callers keep their
 *  existing best-effort try/catch semantics. */
export function writeFileAtomicSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
    throw err;
  }
}

/** Asynchronous atomic write, for callers already on fs/promises. Same
 *  semantics as writeFileAtomicSync. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  try {
    await writeFile(tmp, data, "utf8");
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
