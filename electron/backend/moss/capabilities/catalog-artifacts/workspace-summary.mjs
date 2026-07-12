import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.cwd());
const entries = await readdir(root, { withFileTypes: true });
const summary = await Promise.all(entries.slice(0, 200).map(async (entry) => {
  const path = resolve(root, entry.name);
  const details = entry.isFile() ? await stat(path) : undefined;
  return { name: entry.name, kind: entry.isDirectory() ? "directory" : "file", bytes: details?.size };
}));
process.stdout.write(`${JSON.stringify({ root, entries: summary }, null, 2)}\n`);