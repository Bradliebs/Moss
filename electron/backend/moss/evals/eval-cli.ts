import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { EvalCase, EvalModelTarget, HarnessMatrixReport, HarnessVariant } from "../../../../common/evals";
import { HarnessMatrixRunner, type MatrixExecutorFactory, buildHarnessManifest } from "./matrix-runner";
import { diffHarnessReports, type HarnessRegressionThresholds } from "./report-diff";

export interface HarnessEvalConfig {
  cases: EvalCase[];
  targets: EvalModelTarget[];
  variants: HarnessVariant[];
  createExecutor: MatrixExecutorFactory;
  evaluatorVersion?: string;
  evaluatorArtifacts?: string[];
}

export interface EvalCliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface EvalCliDependencies {
  loadConfig?: (path: string) => HarnessEvalConfig;
  loadThresholds?: (path: string) => HarnessRegressionThresholds;
  readReport?: (path: string) => HarnessMatrixReport;
  io?: EvalCliIo;
}

export async function runEvalCli(args: string[], dependencies: EvalCliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? { stdout: console.log, stderr: console.error };
  const loadConfig = dependencies.loadConfig ?? loadHarnessConfig;
  const loadThresholds = dependencies.loadThresholds ?? readThresholds;
  const loadReport = dependencies.readReport ?? readReport;
  const [command, ...paths] = args;

  if (command === "dry-run") {
    requirePaths(command, paths, 1);
    const config = loadConfig(resolve(paths[0]));
    const manifest = buildHarnessManifest(
      config.cases,
      config.targets,
      config.variants,
      config.evaluatorVersion,
      config.evaluatorArtifacts,
    );
    const repetitions = config.cases.reduce((sum, testCase) => sum + (testCase.repetitions ?? 1), 0);
    const cells = repetitions * config.targets.length * config.variants.length;
    io.stdout(JSON.stringify({ valid: true, cells, manifest }, null, 2));
    return 0;
  }

  if (command === "run") {
    requirePaths(command, paths, 2);
    const config = loadConfig(resolve(paths[0]));
    const report = await new HarnessMatrixRunner(config.createExecutor, {
      evaluatorVersion: config.evaluatorVersion,
      evaluatorArtifacts: config.evaluatorArtifacts,
    }).run(config.cases, config.targets, config.variants);
    writeJson(resolve(paths[1]), report);
    io.stdout(`Wrote ${report.cells.length} matrix cells to ${resolve(paths[1])}`);
    return 0;
  }

  if (command === "diff") {
    const diffArgs = parseDiffArgs(paths);
    const baseline = loadReport(resolve(diffArgs.baseline));
    const candidate = loadReport(resolve(diffArgs.candidate));
    const thresholds = diffArgs.policy ? loadThresholds(resolve(diffArgs.policy)) : undefined;
    const diff = diffHarnessReports(baseline, candidate, thresholds);
    const serialized = JSON.stringify(diff, null, 2);
    if (diffArgs.output) writeJson(resolve(diffArgs.output), diff);
    else io.stdout(serialized);
    return diff.passed ? 0 : 1;
  }

  io.stderr("Usage: eval <run CONFIG REPORT | dry-run CONFIG | diff BASELINE CANDIDATE [OUTPUT] [--policy POLICY]>");
  return 2;
}

function loadHarnessConfig(path: string): HarnessEvalConfig {
  const loaded: unknown = require(path);
  const config = isRecord(loaded) && "default" in loaded ? loaded.default : loaded;
  if (!isHarnessEvalConfig(config)) throw new Error(`Invalid harness config: ${path}`);
  return config;
}

function isHarnessEvalConfig(value: unknown): value is HarnessEvalConfig {
  return isRecord(value)
    && Array.isArray(value.cases)
    && Array.isArray(value.targets)
    && Array.isArray(value.variants)
    && typeof value.createExecutor === "function";
}

function readReport(path: string): HarnessMatrixReport {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.manifest) || !Array.isArray(value.cells)) {
    throw new Error(`Invalid harness report: ${path}`);
  }
  return value as unknown as HarnessMatrixReport;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function requirePaths(command: string, paths: string[], minimum: number, maximum = minimum): void {
  if (paths.length < minimum || paths.length > maximum || paths.some((path) => !path.trim())) {
    throw new Error(`Invalid arguments for eval ${command}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (require.main === module) {
  void runEvalCli(process.argv.slice(2))
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
}

function readThresholds(path: string): HarnessRegressionThresholds {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error(`Invalid harness threshold policy: ${path}`);
  const allowed = new Set([
    "maxTokenIncrease",
    "maxCostIncreaseUsd",
    "maxDurationIncreaseMs",
    "maxActionIncrease",
    "minProcessDelta",
  ]);
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key) || typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error(`Invalid harness threshold policy: ${path}`);
    }
    if (key === "minProcessDelta" && (item < -1 || item > 1)) {
      throw new Error(`Invalid harness threshold policy: ${path}`);
    }
    if (key !== "minProcessDelta" && item < 0) throw new Error(`Invalid harness threshold policy: ${path}`);
  }
  return value as HarnessRegressionThresholds;
}

function parseDiffArgs(paths: string[]): { baseline: string; candidate: string; output?: string; policy?: string } {
  if (paths.length < 2 || paths.some((path) => !path.trim())) throw new Error("Invalid arguments for eval diff");
  const positional = paths.slice(0, 2);
  const remaining = paths.slice(2);
  const policyIndex = remaining.indexOf("--policy");
  let policy: string | undefined;
  if (policyIndex >= 0) {
    policy = remaining[policyIndex + 1];
    if (!policy || remaining.indexOf("--policy", policyIndex + 1) >= 0) throw new Error("Invalid arguments for eval diff");
    remaining.splice(policyIndex, 2);
  }
  if (remaining.length > 1 || remaining.some((path) => path.startsWith("--"))) {
    throw new Error("Invalid arguments for eval diff");
  }
  return { baseline: positional[0], candidate: positional[1], output: remaining[0], policy };
}