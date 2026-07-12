import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { resolveInWorkspace } from "../tools/path-guard";
import { runVerify } from "./verifier";

export interface VerificationCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  checkIds: string[];
}

interface CheckBase {
  id: string;
  criterionId: string;
  kind: string;
}

export interface CommandVerificationCheck extends CheckBase {
  kind: "command";
  command: string;
}

export interface FileExistsVerificationCheck extends CheckBase {
  kind: "file-exists";
  path: string;
}

export interface FileContainsVerificationCheck extends CheckBase {
  kind: "file-contains";
  path: string;
  substring: string;
}

export interface ProcessRunningVerificationCheck extends CheckBase {
  kind: "process-running";
  pid: number;
}

export interface HttpVerificationCheck extends CheckBase {
  kind: "http";
  url: string;
  method?: string;
  expectedStatus?: number;
  bodyIncludes?: string;
  timeoutMs?: number;
}

export interface ReceiptVerificationCheck extends CheckBase {
  kind: "receipt";
  asserted: boolean;
  receipt?: string;
  source?: "manual" | "external";
}

export type VerificationCheck =
  | CommandVerificationCheck
  | FileExistsVerificationCheck
  | FileContainsVerificationCheck
  | ProcessRunningVerificationCheck
  | HttpVerificationCheck
  | ReceiptVerificationCheck
  | CheckBase;

export interface VerificationEvidence {
  criterionId: string;
  checkId: string;
  kind: string;
  ok: boolean;
  timestamp: string;
  summary: string;
  details?: string;
}

export interface VerificationHandlerResult {
  ok: boolean;
  summary: string;
  details?: string;
}

export interface VerificationHandlerContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

export type VerificationHandler = (
  check: VerificationCheck,
  context: VerificationHandlerContext,
) => Promise<VerificationHandlerResult>;

export interface CriterionCoverage {
  criterionId: string;
  mandatory: boolean;
  covered: boolean;
  missingCheckIds: string[];
  failingCheckIds: string[];
}

export interface MandatoryCriterionCoverage {
  complete: boolean;
  criteria: CriterionCoverage[];
}

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export class VerificationRegistry {
  private readonly handlers = new Map<string, VerificationHandler>();

  constructor(registerBuiltIns = true) {
    if (registerBuiltIns) this.registerBuiltIns();
  }

  register(kind: string, handler: VerificationHandler): void {
    const normalizedKind = kind.trim();
    if (!normalizedKind) throw new Error("Verification kind is required");
    if (this.handlers.has(normalizedKind)) {
      throw new Error(`Verification handler already registered: ${normalizedKind}`);
    }
    this.handlers.set(normalizedKind, handler);
  }

  async runChecks(
    checks: VerificationCheck[],
    workspaceRoot: string,
    signal: AbortSignal,
  ): Promise<VerificationEvidence[]> {
    const evidence: VerificationEvidence[] = [];

    for (const check of checks) {
      const timestamp = new Date().toISOString();
      if (signal.aborted) {
        evidence.push(this.toEvidence(check, timestamp, {
          ok: false,
          summary: "Verification aborted",
        }));
        continue;
      }

      const handler = this.handlers.get(check.kind);
      if (!handler) {
        evidence.push(this.toEvidence(check, timestamp, {
          ok: false,
          summary: `Unknown verification kind: ${check.kind}`,
        }));
        continue;
      }

      try {
        const result = await handler(check, { workspaceRoot, signal });
        evidence.push(this.toEvidence(check, timestamp, result));
      } catch (error) {
        evidence.push(this.toEvidence(check, timestamp, {
          ok: false,
          summary: "Verification check failed",
          details: errorMessage(error),
        }));
      }
    }

    return evidence;
  }

  private toEvidence(
    check: VerificationCheck,
    timestamp: string,
    result: VerificationHandlerResult,
  ): VerificationEvidence {
    return {
      criterionId: check.criterionId,
      checkId: check.id,
      kind: check.kind,
      timestamp,
      ...result,
    };
  }

  private registerBuiltIns(): void {
    this.register("command", runCommandCheck);
    this.register("file-exists", runFileExistsCheck);
    this.register("file-contains", runFileContainsCheck);
    this.register("process-running", runProcessRunningCheck);
    this.register("http", runHttpCheck);
    this.register("receipt", runReceiptCheck);
  }
}

export function computeMandatoryCriterionCoverage(
  criteria: VerificationCriterion[],
  evidence: VerificationEvidence[],
): MandatoryCriterionCoverage {
  const newestByCheck = new Map<string, VerificationEvidence>();
  for (const item of evidence) {
    const key = `${item.criterionId}\0${item.checkId}`;
    const current = newestByCheck.get(key);
    if (!current || Date.parse(item.timestamp) > Date.parse(current.timestamp)) {
      newestByCheck.set(key, item);
    }
  }

  const coverage = criteria.map((criterion): CriterionCoverage => {
    const missingCheckIds: string[] = [];
    const failingCheckIds: string[] = [];
    for (const checkId of criterion.checkIds) {
      const item = newestByCheck.get(`${criterion.id}\0${checkId}`);
      if (!item) missingCheckIds.push(checkId);
      else if (!item.ok) failingCheckIds.push(checkId);
    }
    return {
      criterionId: criterion.id,
      mandatory: criterion.mandatory,
      covered: missingCheckIds.length === 0 && failingCheckIds.length === 0,
      missingCheckIds,
      failingCheckIds,
    };
  });

  return {
    complete: coverage.filter((item) => item.mandatory).every((item) => item.covered),
    criteria: coverage,
  };
}

export async function detectWorkspaceVerificationChecks(
  workspaceRoot: string,
  criterionId = "workspace-verification",
): Promise<CommandVerificationCheck[]> {
  let packagePath: string;
  try {
    packagePath = await resolveExistingWorkspacePath(workspaceRoot, "package.json");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return [];
  const scripts = parsed.scripts;

  return (["typecheck", "test", "build"] as const)
    .filter((script) => typeof scripts[script] === "string")
    .map((script) => ({
      id: `package-script-${script}`,
      criterionId,
      kind: "command",
      command: `npm run ${script}`,
    }));
}

async function runCommandCheck(
  check: VerificationCheck,
  context: VerificationHandlerContext,
): Promise<VerificationHandlerResult> {
  const commandCheck = check as CommandVerificationCheck;
  const result = await runVerify([commandCheck.command], context.workspaceRoot, context.signal);
  const commandResult = result.results[0];
  if (!commandResult) {
    return { ok: false, summary: context.signal.aborted ? "Verification aborted" : "Command did not run" };
  }
  return {
    ok: commandResult.ok,
    summary: `${commandResult.ok ? "Command passed" : "Command failed"}: ${commandResult.command}`,
    details: commandResult.output,
  };
}

async function runFileExistsCheck(
  check: VerificationCheck,
  context: VerificationHandlerContext,
): Promise<VerificationHandlerResult> {
  const fileCheck = check as FileExistsVerificationCheck;
  try {
    const target = await resolveExistingWorkspacePath(context.workspaceRoot, fileCheck.path);
    await stat(target);
    return { ok: true, summary: `Path exists: ${fileCheck.path}` };
  } catch (error) {
    return { ok: false, summary: `Path does not exist or is inaccessible: ${fileCheck.path}`, details: errorMessage(error) };
  }
}

async function runFileContainsCheck(
  check: VerificationCheck,
  context: VerificationHandlerContext,
): Promise<VerificationHandlerResult> {
  const fileCheck = check as FileContainsVerificationCheck;
  const target = await resolveExistingWorkspacePath(context.workspaceRoot, fileCheck.path);
  const content = await readFile(target, "utf8");
  const ok = content.includes(fileCheck.substring);
  return { ok, summary: `${fileCheck.path} ${ok ? "contains" : "does not contain"} the expected text` };
}

async function runProcessRunningCheck(check: VerificationCheck): Promise<VerificationHandlerResult> {
  const processCheck = check as ProcessRunningVerificationCheck;
  if (!Number.isSafeInteger(processCheck.pid) || processCheck.pid <= 0) {
    return { ok: false, summary: `Invalid process ID: ${processCheck.pid}` };
  }
  try {
    process.kill(processCheck.pid, 0);
    return { ok: true, summary: `Process is running: ${processCheck.pid}` };
  } catch (error) {
    return { ok: false, summary: `Process is not running: ${processCheck.pid}`, details: errorMessage(error) };
  }
}

async function runHttpCheck(
  check: VerificationCheck,
  context: VerificationHandlerContext,
): Promise<VerificationHandlerResult> {
  const httpCheck = check as HttpVerificationCheck;
  const timeoutController = new AbortController();
  const onParentAbort = (): void => timeoutController.abort(context.signal.reason);
  context.signal.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("HTTP verification timed out")),
    httpCheck.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
  );

  try {
    const response = await fetch(httpCheck.url, {
      method: httpCheck.method ?? "GET",
      signal: timeoutController.signal,
    });
    const body = httpCheck.bodyIncludes === undefined ? undefined : await response.text();
    const statusOk = httpCheck.expectedStatus === undefined || response.status === httpCheck.expectedStatus;
    const bodyOk = httpCheck.bodyIncludes === undefined || body?.includes(httpCheck.bodyIncludes) === true;
    const ok = statusOk && bodyOk;
    return {
      ok,
      summary: `HTTP ${response.status} ${ok ? "matched" : "did not match"} expectations`,
      details: !statusOk
        ? `Expected status ${httpCheck.expectedStatus}`
        : !bodyOk
          ? `Response body did not include: ${httpCheck.bodyIncludes}`
          : undefined,
    };
  } finally {
    clearTimeout(timeout);
    context.signal.removeEventListener("abort", onParentAbort);
  }
}

async function runReceiptCheck(check: VerificationCheck): Promise<VerificationHandlerResult> {
  const receiptCheck = check as ReceiptVerificationCheck;
  const source = receiptCheck.source ?? "external";
  return {
    ok: receiptCheck.asserted,
    summary: receiptCheck.asserted ? `${source} receipt asserted` : `${source} receipt not asserted`,
    details: receiptCheck.receipt,
  };
}

async function resolveExistingWorkspacePath(workspaceRoot: string, inputPath: string): Promise<string> {
  const target = resolveInWorkspace(workspaceRoot, inputPath);
  const [realRoot, realTarget] = await Promise.all([realpath(workspaceRoot), realpath(target)]);
  const rel = relative(realRoot, realTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes the workspace sandbox: ${inputPath}`);
  }
  return realTarget;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}