import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { EvalCase, EvalModelTarget, HarnessMatrixReport, HarnessVariant } from "../../../../common/evals";
import { HarnessMatrixRunner, type MatrixExecutorFactory, buildHarnessManifest } from "./matrix-runner";
import { diffHarnessReports } from "./report-diff";

export interface HarnessEvalConfig {
  cases: EvalCase[];
  targets: EvalModelTarget[];
  variants: HarnessVariant[];
  createExecutor: MatrixExecutorFactory;
  evaluatorVersion?: string;
}

export interface EvalCliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

export interface EvalCliDependencies {
  loadConfig?: (path: string) => HarnessEvalConfig;
  io?: EvalCliIo;
}

export async function runEvalCli(args: string[], dependencies: EvalCliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? { stdout: console.log, stderr: console.error };
  const loadConfig = dependencies.loadConfig ?? loadHarnessConfig;
  const [command, ...paths] = args;

  if (command === "dry-run") {
    requirePaths(command, paths, 1);
    const config = loadConfig(resolve(paths[0]));
    const manifest = buildHarnessManifest(config.cases, config.targets, config.variants, config.evaluatorVersion);
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
    }).run(config.cases, config.targets, config.variants);
    writeJson(resolve(paths[1]), report);
    io.stdout(`Wrote ${report.cells.length} matrix cells to ${resolve(paths[1])}`);
    return 0;
  }

  if (command === "diff") {
    requirePaths(command, paths, 2, 3);
    const baseline = readReport(resolve(paths[0]));
    const candidate = readReport(resolve(paths[1]));
    const diff = diffHarnessReports(baseline, candidate);
    const serialized = JSON.stringify(diff, null, 2);
    if (paths[2]) writeJson(resolve(paths[2]), diff);
    else io.stdout(serialized);
    return diff.passed ? 0 : 1;
  }

  io.stderr("Usage: eval <run CONFIG REPORT | dry-run CONFIG | diff BASELINE CANDIDATE [OUTPUT]>");
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