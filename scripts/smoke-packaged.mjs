import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron } from "playwright";

const executablePath = resolve("release", "win-unpacked", "Moss.exe");
assert.ok(existsSync(executablePath), `Packaged executable not found: ${executablePath}`);

const userDataDir = mkdtempSync(join(tmpdir(), "moss-packaged-smoke-"));
let application;
try {
  application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    timeout: 30_000,
  });
  const window = await application.firstWindow({ timeout: 30_000 });
  await window.getByRole("heading", { name: "Moss" }).waitFor();
  await window.getByRole("button", { name: "Mission" }).click();
  await window.getByText("Review mission").click();
  await window.getByLabel("Mission review").waitFor();
  for (const label of ["Mission Minutes", "Mission Tokens", "Mission Actions", "Mission Cost USD"]) {
    await window.getByLabel(label).waitFor();
  }
  console.log("Packaged Mission UI smoke passed.");
} finally {
  await application?.close().catch(() => undefined);
  rmSync(userDataDir, { recursive: true, force: true });
}