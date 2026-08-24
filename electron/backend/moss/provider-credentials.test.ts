import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8").map((byte) => byte ^ 0xa5),
    decryptString: (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString("utf8"),
  },
}));

import { providerCredentials } from "./provider-credentials";

beforeEach(() => {
  electronMock.userData = mkdtempSync(join(tmpdir(), "moss-credentials-"));
});

afterEach(() => {
  rmSync(electronMock.userData, { recursive: true, force: true });
});

describe("providerCredentials", () => {
  it("round-trips separate provider keys without writing plaintext", () => {
    providerCredentials.set("openai", "openai-secret");
    providerCredentials.set("anthropic", "anthropic-secret");

    expect(providerCredentials.get("openai")).toBe("openai-secret");
    expect(providerCredentials.get("anthropic")).toBe("anthropic-secret");
    const persisted = readFileSync(join(electronMock.userData, "provider-credentials.json"), "utf8");
    expect(persisted).not.toContain("openai-secret");
    expect(persisted).not.toContain("anthropic-secret");
  });

  it("removes a key when set to an empty value and rejects invalid ids", () => {
    providerCredentials.set("xai", "xai-secret");
    providerCredentials.set("xai", "");
    expect(providerCredentials.get("xai")).toBe("");
    expect(() => providerCredentials.set("../invalid", "secret")).toThrow(/Invalid provider credential id/);
  });
});