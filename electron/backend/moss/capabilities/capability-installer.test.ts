import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CapabilityCatalog } from "./capability-catalog";
import { CapabilityInstaller } from "./capability-installer";

describe("CapabilityInstaller", () => {
  let dir: string;
  let source: string;
  let payload: Buffer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moss-capability-"));
    source = join(dir, "fixture.js");
    payload = Buffer.from("require('node:fs').writeFileSync('should-not-exist', 'ran');\n", "utf8");
    writeFileSync(source, payload);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function installer(overrides: { sha256?: string; platforms?: string[] } = {}): CapabilityInstaller {
    const catalog = new CapabilityCatalog({
      schemaVersion: 1,
      entries: [
        {
          id: "fixture-tool",
          version: "1.0.0",
          sourceUrl: pathToFileURL(source).href,
          sha256: overrides.sha256 ?? createHash("sha256").update(payload).digest("hex"),
          platforms: overrides.platforms ?? ["win32"],
          runtime: "node",
          entry: { command: "node", args: ["artifact.raw"] },
          permissions: [],
          toolIds: ["fixture.run"],
        },
      ],
    });
    return new CapabilityInstaller(catalog, { baseDir: dir, platform: "win32" });
  }

  it("installs a verified raw artifact with provenance without executing it", async () => {
    const status = await installer().install("fixture-tool", "1.0.0");
    expect(status.state).toBe("installed");
    expect(status.active).toBe(true);
    expect(readFileSync(join(status.directory!, "artifact.raw"))).toEqual(payload);
    expect(status.provenance).toMatchObject({
      id: "fixture-tool",
      version: "1.0.0",
      artifactType: "raw-single-file",
      state: "installed",
    });
    expect(existsSync(join(dir, "should-not-exist"))).toBe(false);
  });

  it("rejects a hash mismatch before creating an installed version", async () => {
    const capabilityInstaller = installer({ sha256: "0".repeat(64) });
    await expect(capabilityInstaller.install("fixture-tool", "1.0.0")).rejects.toThrow("sha256 mismatch");
    expect((await capabilityInstaller.status("fixture-tool", "1.0.0")).state).toBe("not-installed");
    expect(existsSync(join(dir, "capabilities", "installed", "fixture-tool", "1.0.0"))).toBe(false);
  });

  it("rejects an incompatible platform", async () => {
    await expect(installer({ platforms: ["linux"] }).install("fixture-tool", "1.0.0")).rejects.toThrow(
      "does not support win32",
    );
  });

  it("quarantines and deactivates an installed version", async () => {
    const capabilityInstaller = installer();
    await capabilityInstaller.install("fixture-tool", "1.0.0");
    const status = await capabilityInstaller.quarantine("fixture-tool", "1.0.0", "failed health review");
    expect(status).toMatchObject({ state: "quarantined", active: false });
    expect(status.provenance).toMatchObject({
      state: "quarantined",
      quarantineReason: "failed health review",
    });
    expect(existsSync(join(dir, "capabilities", "installed", "fixture-tool", "1.0.0"))).toBe(false);
  });

  it("removes installed or quarantined versions", async () => {
    const capabilityInstaller = installer();
    await capabilityInstaller.install("fixture-tool", "1.0.0");
    await capabilityInstaller.quarantine("fixture-tool", "1.0.0", "manual review");
    await capabilityInstaller.remove("fixture-tool", "1.0.0");
    expect(await capabilityInstaller.status("fixture-tool", "1.0.0")).toEqual({
      id: "fixture-tool",
      version: "1.0.0",
      state: "not-installed",
      active: false,
    });
  });

  it("rejects entries and duplicate installs outside the curated state", async () => {
    const capabilityInstaller = installer();
    await expect(capabilityInstaller.status("unknown", "1.0.0")).rejects.toThrow("not in the catalog");
    await capabilityInstaller.install("fixture-tool", "1.0.0");
    await expect(capabilityInstaller.install("fixture-tool", "1.0.0")).rejects.toThrow("already installed");
  });
});