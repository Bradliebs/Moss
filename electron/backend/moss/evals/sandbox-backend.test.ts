import { describe, expect, it, vi } from "vitest";

import { buildDockerArgs, DockerEvalSandboxBackend } from "./sandbox-backend";

const request = {
  workspaceRoot: "C:\\work\\fixture",
  command: "npm test",
  signal: new AbortController().signal,
};

describe("DockerEvalSandboxBackend", () => {
  it("builds a networkless resource-bounded container invocation", () => {
    const args = buildDockerArgs({ image: "node:22-alpine", memoryMb: 256, cpus: 0.5, pidsLimit: 32 }, request);

    expect(args).toEqual(expect.arrayContaining([
      "--network", "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "32",
      "--memory", "256m",
      "--cpus", "0.5",
      "--workdir", "/workspace",
      "node:22-alpine",
      "sh", "-lc", "npm test",
    ]));
    expect(args.join(" ")).toContain("target=/workspace");
  });

  it("uses an argument-vector process runner without a host shell", async () => {
    const processRunner = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }));
    const backend = new DockerEvalSandboxBackend({ image: "node:22-alpine", processRunner });

    await expect(backend.run(request)).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(processRunner).toHaveBeenCalledWith("docker", expect.arrayContaining(["run", "--network", "none"]), request);
  });

  it("rejects unsafe unbounded option values", () => {
    expect(() => new DockerEvalSandboxBackend({ image: "node:22-alpine", memoryMb: 32 })).toThrow("memoryMb");
    expect(() => new DockerEvalSandboxBackend({ image: "", cpus: 1 })).toThrow("image");
  });
});
