import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type {
  EvalCase,
  EvalDifficulty,
  EvalModelTarget,
  EvalProfile,
  HarnessAggregateMetrics,
  HarnessMatrixCellResult,
  HarnessMatrixManifest,
  HarnessMatrixReport,
  HarnessVariant,
} from "../../../../common/evals";
import { VerificationRegistry } from "../verify/verification-registry";
import { type EvalExecutionResult, type EvalExecutor, EvalRunner, validateCase } from "./eval-runner";
import { scoreHarnessRun } from "./harness-scoring";

export type MatrixExecutorFactory = (
  target: EvalModelTarget,
  variant: HarnessVariant,
  workspaceRoot: string,
) => EvalExecutor;

export interface HarnessMatrixRunnerOptions {
  temporaryRoot?: string;
  now?: () => Date;
  registry?: VerificationRegistry;
  evaluatorVersion?: string;
}

/** Expands model, harness, case, and repetition axes into isolated executions. */
export class HarnessMatrixRunner {
  private readonly temporaryRoot: string;
  private readonly now: () => Date;
  private readonly registry: VerificationRegistry;
  private readonly evaluatorVersion: string;

  constructor(
    private readonly createExecutor: MatrixExecutorFactory,
    options: HarnessMatrixRunnerOptions = {},
  ) {
    this.temporaryRoot = options.temporaryRoot ?? tmpdir();
    this.now = options.now ?? (() => new Date());
    this.registry = options.registry ?? new VerificationRegistry();
    this.evaluatorVersion = options.evaluatorVersion ?? "moss-harness-v1";
  }

  async run(
    cases: readonly EvalCase[],
    targets: readonly EvalModelTarget[],
    variants: readonly HarnessVariant[],
  ): Promise<HarnessMatrixReport> {
    validateHarnessMatrix(cases, targets, variants);
    const cells: HarnessMatrixCellResult[] = [];

    for (const target of targets) {
      for (const variant of variants) {
        for (const testCase of cases) {
          const repetitions = testCase.repetitions ?? 1;
          for (let repetition = 0; repetition < repetitions; repetition++) {
            cells.push(await this.runCell(testCase, target, variant, repetition));
          }
        }
      }
    }

    return {
      schemaVersion: 1,
      generatedAt: this.now().toISOString(),
      manifest: buildHarnessManifest(cases, targets, variants, this.evaluatorVersion),
      cells,
      summary: summarizeHarnessMatrix(cells, cases),
    };
  }

  private async runCell(
    testCase: EvalCase,
    target: EvalModelTarget,
    variant: HarnessVariant,
    repetition: number,
  ): Promise<HarnessMatrixCellResult> {
    const workspaceRoot = mkdtempSync(join(this.temporaryRoot, "moss-eval-"));
    let execution: EvalExecutionResult | undefined;
    try {
      if (testCase.fixture?.workspaceTemplate) {
        cpSync(testCase.fixture.workspaceTemplate, workspaceRoot, { recursive: true });
      }
      const protectedPaths = testCase.benchmark?.security?.protectedPaths ?? [];
      const protectedInputHashesBefore = hashProtectedInputs(workspaceRoot, protectedPaths);
      const execute = this.createExecutor(structuredClone(target), structuredClone(variant), workspaceRoot);
      const captureExecution: EvalExecutor = async (isolatedCase, _ignoredRepetition) => {
        execution = await execute(isolatedCase, repetition);
        if (resolve(execution.workspaceRoot) !== resolve(workspaceRoot)) {
          throw new Error(`Matrix executor escaped isolated workspace for case '${testCase.id}'`);
        }
        return execution;
      };
      const report = await new EvalRunner(captureExecution, {
        now: this.now,
        registry: this.registry,
      }).run([{ ...structuredClone(testCase), repetitions: 1 }]);
      const result = report.results[0];
      if (!result || !execution) throw new Error(`Matrix cell '${testCase.id}' produced no result`);
      const protectedInputHashesAfter = hashProtectedInputs(workspaceRoot, protectedPaths);
      const protectedInputsIntact = equalHashes(protectedInputHashesBefore, protectedInputHashesAfter);
      const harnessScore = execution.trace ? scoreHarnessRun(testCase, result, execution.trace) : undefined;
      if (harnessScore && !protectedInputsIntact) {
        harnessScore.securityPassed = false;
        harnessScore.securityViolations.push("protected-input-modified");
        harnessScore.diagnosticComposite = 0;
      }
      return {
        caseId: testCase.id,
        targetId: target.id,
        variantId: variant.id,
        repetition,
        result,
        trace: execution.trace,
        harnessScore,
        protectedInputHashesBefore,
        protectedInputHashesAfter,
        protectedInputsIntact,
      };
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
}

export function validateHarnessMatrix(
  cases: readonly EvalCase[],
  targets: readonly EvalModelTarget[],
  variants: readonly HarnessVariant[],
): void {
  if (cases.length === 0 || targets.length === 0 || variants.length === 0) {
    throw new Error("Harness matrix requires at least one case, target, and variant");
  }
  for (const testCase of cases) validateCase(testCase);
  validateUniqueIds("case", cases);
  validateUniqueIds("model target", targets);
  validateUniqueIds("harness variant", variants);
  for (const target of targets) {
    if (target.schemaVersion !== 1 || !target.providerId.trim() || !target.model.trim()) {
      throw new Error(`Invalid model target '${target.id}'`);
    }
  }
  for (const variant of variants) {
    if (variant.schemaVersion !== 1 || !variant.description.trim()) {
      throw new Error(`Invalid harness variant '${variant.id}'`);
    }
  }
  const variantBudgets = new Set(variants.map((variant) => JSON.stringify(canonicalize(variant.budget ?? null))));
  if (variantBudgets.size > 1) {
    throw new Error("Compared harness variants must use the same execution budget");
  }
}

function validateUniqueIds(label: string, values: readonly { id: string }[]): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value.id) || ids.has(value.id)) {
      throw new Error(`Harness matrix ${label} ids must be unique safe identifiers`);
    }
    ids.add(value.id);
  }
}

function hashProtectedInputs(workspaceRoot: string, paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path.replace(/\\/g, "/"), hashWorkspacePath(workspaceRoot, path)]));
}

function hashWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("Protected path escapes isolated workspace");
  if (!existsSync(target)) return "missing";
  const hash = createHash("sha256");
  appendPathToHash(hash, target, basename(target));
  return hash.digest("hex");
}

function appendPathToHash(hash: ReturnType<typeof createHash>, path: string, label: string): void {
  const stat = lstatSync(path);
  hash.update(label);
  if (stat.isSymbolicLink()) {
    throw new Error(`Protected input '${label}' must not be a symbolic link`);
  }
  if (stat.isDirectory()) {
    for (const child of readdirSync(path).sort()) appendPathToHash(hash, join(path, child), `${label}/${child}`);
    return;
  }
  hash.update(readFileSync(path));
}

function equalHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function fingerprintCases(cases: readonly EvalCase[]): string {
  return stableHash(cases.map((testCase) => ({
    ...testCase,
    fixture: testCase.fixture
      ? {
        ...testCase.fixture,
        workspaceTemplate: testCase.fixture.workspaceTemplate
          ? hashExternalPath(testCase.fixture.workspaceTemplate)
          : undefined,
      }
      : undefined,
  })));
}

function hashExternalPath(path: string): string {
  if (!existsSync(path)) throw new Error(`Eval fixture template does not exist: ${path}`);
  const hash = createHash("sha256");
  appendPathToHash(hash, resolve(path), ".");
  return hash.digest("hex");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function buildHarnessManifest(
  cases: readonly EvalCase[],
  targets: readonly EvalModelTarget[],
  variants: readonly HarnessVariant[],
  evaluatorVersion = "moss-harness-v1",
): HarnessMatrixManifest {
  validateHarnessMatrix(cases, targets, variants);
  if (!evaluatorVersion.trim()) throw new Error("Harness evaluator version is required");
  return {
    evaluatorVersion,
    caseIds: cases.map((testCase) => testCase.id),
    targetIds: targets.map((target) => target.id),
    variantIds: variants.map((variant) => variant.id),
    caseSetHash: fingerprintCases(cases),
    targetSetHash: stableHash(targets),
    variantSetHash: stableHash(variants),
  };
}

export function summarizeHarnessMatrix(
  cells: readonly HarnessMatrixCellResult[],
  cases: readonly EvalCase[],
): HarnessMatrixReport["summary"] {
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const byTargetVariant = groupMetrics(cells, (cell) => `${cell.targetId}/${cell.variantId}`);
  const byProfile = groupMetrics(cells, (cell) => casesById.get(cell.caseId)?.profile) as Partial<
    Record<EvalProfile, HarnessAggregateMetrics>
  >;
  const byDifficulty = groupMetrics(cells, (cell) => casesById.get(cell.caseId)?.difficulty) as Partial<
    Record<EvalDifficulty, HarnessAggregateMetrics>
  >;
  const taggedCells = new Map<string, HarnessMatrixCellResult[]>();
  for (const cell of cells) {
    for (const tag of casesById.get(cell.caseId)?.tags ?? []) {
      const group = taggedCells.get(tag) ?? [];
      group.push(cell);
      taggedCells.set(tag, group);
    }
  }

  return {
    overall: aggregateHarnessMetrics(cells),
    byTargetVariant,
    byProfile,
    byDifficulty,
    byTag: Object.fromEntries([...taggedCells].sort(([left], [right]) => left.localeCompare(right))
      .map(([tag, group]) => [tag, aggregateHarnessMetrics(group)])),
  };
}

function groupMetrics(
  cells: readonly HarnessMatrixCellResult[],
  selectKey: (cell: HarnessMatrixCellResult) => string | undefined,
): Record<string, HarnessAggregateMetrics> {
  const groups = new Map<string, HarnessMatrixCellResult[]>();
  for (const cell of cells) {
    const key = selectKey(cell);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => [key, aggregateHarnessMetrics(group)]));
}

function aggregateHarnessMetrics(cells: readonly HarnessMatrixCellResult[]): HarnessAggregateMetrics {
  const scored = cells.filter((cell) => cell.harnessScore !== undefined);
  const average = (values: number[]): number => values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    runs: cells.length,
    scoredRuns: scored.length,
    completions: cells.filter((cell) => cell.result.success).length,
    completionRate: cells.length === 0 ? 0 : cells.filter((cell) => cell.result.success).length / cells.length,
    securityPasses: scored.filter((cell) => cell.harnessScore?.securityPassed).length,
    securityPassRate: scored.length === 0
      ? 0
      : scored.filter((cell) => cell.harnessScore?.securityPassed).length / scored.length,
    protectedInputsIntact: cells.filter((cell) => cell.protectedInputsIntact).length,
    averageRobustness: average(scored.map((cell) => cell.harnessScore!.process.robustness)),
    averageToolUse: average(scored.map((cell) => cell.harnessScore!.process.toolUse)),
    averageConsistency: average(scored.map((cell) => cell.harnessScore!.process.consistency)),
    averageDiagnosticComposite: average(scored.map((cell) => cell.harnessScore!.diagnosticComposite)),
    averageTokens: average(cells.map((cell) => {
      const usage = cell.result.observation.usage;
      return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    })),
    averageCostUsd: average(cells.map((cell) => cell.result.observation.estimatedCostUsd)),
    averageDurationMs: average(cells.map((cell) => cell.result.durationMs)),
    averageActions: average(cells.map((cell) => cell.trace?.toolCalls.length ?? 0)),
  };
}