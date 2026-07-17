import type {
  HarnessCellDiff,
  HarnessMatrixCellResult,
  HarnessMatrixReport,
  HarnessReportDiff,
} from "../../../../common/evals";

export interface HarnessRegressionThresholds {
  maxTokenIncrease?: number;
  maxCostIncreaseUsd?: number;
  maxDurationIncreaseMs?: number;
  maxActionIncrease?: number;
  minProcessDelta?: number;
}

/** Compare only like-for-like reports and gate each observable signal separately. */
export function diffHarnessReports(
  baseline: HarnessMatrixReport,
  candidate: HarnessMatrixReport,
  thresholds: HarnessRegressionThresholds = {},
): HarnessReportDiff {
  assertCompatible(baseline, candidate);
  const candidateCells = new Map(candidate.cells.map((cell) => [cellKey(cell), cell]));
  const cells: HarnessCellDiff[] = [];
  const regressions: string[] = [];

  for (const baselineCell of baseline.cells) {
    const key = cellKey(baselineCell);
    const candidateCell = candidateCells.get(key);
    if (!candidateCell) throw new Error(`Candidate report is missing matrix cell '${key}'`);
    if (!baselineCell.harnessScore || !candidateCell.harnessScore) {
      throw new Error(`Matrix cell '${key}' is missing deterministic harness scores`);
    }
    const delta = buildCellDiff(baselineCell, candidateCell);
    cells.push(delta);
    const label = `${baselineCell.targetId}/${baselineCell.variantId}/${baselineCell.caseId}#${baselineCell.repetition}`;
    if (baselineCell.result.success && !candidateCell.result.success) regressions.push(`${label}: completion regressed`);
    if (baselineCell.harnessScore.securityPassed && !candidateCell.harnessScore.securityPassed) {
      regressions.push(`${label}: security regressed`);
    }
    const minProcessDelta = thresholds.minProcessDelta ?? 0;
    if (delta.robustnessDelta < minProcessDelta) regressions.push(`${label}: robustness regressed by ${delta.robustnessDelta}`);
    if (delta.toolUseDelta < minProcessDelta) regressions.push(`${label}: tool use regressed by ${delta.toolUseDelta}`);
    if (delta.consistencyDelta < minProcessDelta) regressions.push(`${label}: consistency regressed by ${delta.consistencyDelta}`);
    if (delta.tokensDelta > (thresholds.maxTokenIncrease ?? 0)) regressions.push(`${label}: tokens increased by ${delta.tokensDelta}`);
    if (delta.costDeltaUsd > (thresholds.maxCostIncreaseUsd ?? 0)) regressions.push(`${label}: cost increased by $${delta.costDeltaUsd}`);
    if (delta.durationDeltaMs > (thresholds.maxDurationIncreaseMs ?? 0)) regressions.push(`${label}: duration increased by ${delta.durationDeltaMs}ms`);
    if (delta.actionsDelta > (thresholds.maxActionIncrease ?? 0)) regressions.push(`${label}: actions increased by ${delta.actionsDelta}`);
  }

  if (candidateCells.size !== baseline.cells.length) {
    throw new Error("Candidate report contains matrix cells absent from the baseline");
  }
  return {
    schemaVersion: 1,
    baselineGeneratedAt: baseline.generatedAt,
    candidateGeneratedAt: candidate.generatedAt,
    passed: regressions.length === 0,
    cells,
    regressions,
  };
}

function assertCompatible(baseline: HarnessMatrixReport, candidate: HarnessMatrixReport): void {
  if (baseline.schemaVersion !== 1 || candidate.schemaVersion !== 1) {
    throw new Error("Unsupported harness report schema version");
  }
  const checks: Array<[string, string, string]> = [
    ["evaluator version", baseline.manifest.evaluatorVersion, candidate.manifest.evaluatorVersion],
    ["case set", baseline.manifest.caseSetHash, candidate.manifest.caseSetHash],
    ["model target set", baseline.manifest.targetSetHash, candidate.manifest.targetSetHash],
    ["harness variant set", baseline.manifest.variantSetHash, candidate.manifest.variantSetHash],
  ];
  for (const [label, left, right] of checks) {
    if (left !== right) throw new Error(`Cannot compare reports with a different ${label}`);
  }
}

function buildCellDiff(baseline: HarnessMatrixCellResult, candidate: HarnessMatrixCellResult): HarnessCellDiff {
  const baselineHarness = baseline.harnessScore!;
  const candidateHarness = candidate.harnessScore!;
  return {
    caseId: baseline.caseId,
    targetId: baseline.targetId,
    variantId: baseline.variantId,
    repetition: baseline.repetition,
    completionChanged: baseline.result.success !== candidate.result.success,
    securityChanged: baselineHarness.securityPassed !== candidateHarness.securityPassed,
    robustnessDelta: candidateHarness.process.robustness - baselineHarness.process.robustness,
    toolUseDelta: candidateHarness.process.toolUse - baselineHarness.process.toolUse,
    consistencyDelta: candidateHarness.process.consistency - baselineHarness.process.consistency,
    tokensDelta: tokens(candidate) - tokens(baseline),
    costDeltaUsd: candidate.result.observation.estimatedCostUsd - baseline.result.observation.estimatedCostUsd,
    durationDeltaMs: candidate.result.durationMs - baseline.result.durationMs,
    actionsDelta: (candidate.trace?.toolCalls.length ?? 0) - (baseline.trace?.toolCalls.length ?? 0),
  };
}

function cellKey(cell: HarnessMatrixCellResult): string {
  return `${cell.targetId}\u0000${cell.variantId}\u0000${cell.caseId}\u0000${cell.repetition}`;
}

function tokens(cell: HarnessMatrixCellResult): number {
  const usage = cell.result.observation.usage;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}