import { spawn } from "node:child_process";
import { resolve } from "node:path";

const OUTPUT_CAP = 8_000;

export interface SandboxCommandRequest {
  workspaceRoot: string;
  command: string;
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface SandboxCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface EvalSandboxBackend {
  readonly kind: "docker";
  run(request: SandboxCommandRequest): Promise<SandboxCommandResult>;
}

export type ContainerProcessRunner = (
  executable: string,
  args: readonly string[],
  request: Pick<SandboxCommandRequest, "signal" | "timeoutMs">,
) => Promise<SandboxCommandResult>;

export interface DockerSandboxOptions {
  image: string;
  dockerExecutable?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  processRunner?: ContainerProcessRunner;
}

export class DockerEvalSandboxBackend implements EvalSandboxBackend {
  readonly kind = "docker" as const;
  private readonly dockerExecutable: string;
  private readonly processRunner: ContainerProcessRunner;

  constructor(private readonly options: DockerSandboxOptions) {
    if (!options.image.trim()) throw new Error("Docker sandbox image is required");
    if ((options.memoryMb ?? 512) < 64) throw new Error("Docker sandbox memoryMb must be at least 64");
    if ((options.cpus ?? 1) <= 0) throw new Error("Docker sandbox cpus must be positive");
    if (!Number.isInteger(options.pidsLimit ?? 128) || (options.pidsLimit ?? 128) < 1) {
      throw new Error("Docker sandbox pidsLimit must be a positive integer");
    }
    this.dockerExecutable = options.dockerExecutable ?? "docker";
    this.processRunner = options.processRunner ?? runContainerProcess;
  }

  async run(request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    if (!request.command.trim()) throw new Error("Sandbox command is required");
    return this.processRunner(this.dockerExecutable, buildDockerArgs(this.options, request), request);
  }
}

export function buildDockerArgs(options: DockerSandboxOptions, request: SandboxCommandRequest): string[] {
  const workspaceRoot = resolve(request.workspaceRoot);
  return [
    "run",
    "--rm",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(options.pidsLimit ?? 128),
    "--memory", `${options.memoryMb ?? 512}m`,
    "--cpus", String(options.cpus ?? 1),
    "--mount", `type=bind,source=${workspaceRoot},target=/workspace`,
    "--workdir", "/workspace",
    options.image,
    "sh", "-lc", request.command,
  ];
}

async function runContainerProcess(
  executable: string,
  args: readonly string[],
  request: Pick<SandboxCommandRequest, "signal" | "timeoutMs">,
): Promise<SandboxCommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: SandboxCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const onAbort = (): void => { child.kill(); };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, request.timeoutMs ?? 180_000);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      reject(new Error(`Docker sandbox failed to start: ${error.message}`));
    });
    child.on("close", (exitCode) => finish({
      exitCode,
      stdout: stdout.slice(0, OUTPUT_CAP),
      stderr: stderr.slice(0, OUTPUT_CAP),
      timedOut,
    }));
  });
}
