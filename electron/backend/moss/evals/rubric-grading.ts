import type {
  EvalRubricAgreementMetrics,
  EvalRubricAssessment,
  EvalRubricCalibrationReport,
  EvalRubricJudgment,
  EvalRubricLabel,
  EvalRubricProvenance,
} from "../../../../common/evals";

const SAFE_ID = /^[a-zA-Z0-9._-]{1,128}$/;
const SHA_256 = /^[a-f0-9]{64}$/;

export interface EvalRubricDimension {
  id: string;
  description: string;
}

export interface EvalRubricGraderInput {
  caseId: string;
  objective: string;
  responseText: string;
}

export interface EvalRubricGrader {
  dimensions: readonly EvalRubricDimension[];
  provenance: EvalRubricProvenance;
  grade: (input: EvalRubricGraderInput & { dimension: EvalRubricDimension }) => Promise<EvalRubricJudgment>;
}

export interface EvalRubricCalibrationSample {
  sampleId: string;
  assessment: EvalRubricAssessment;
  humanLabels: Record<string, Exclude<EvalRubricLabel, "unknown">>;
}

export interface EvalRubricCalibrationPolicy {
  minimumLabelsPerDimension?: number;
  minimumCoverage?: number;
  minimumAgreement?: number;
}

export async function runRubricGrader(
  grader: EvalRubricGrader,
  input: EvalRubricGraderInput,
): Promise<EvalRubricAssessment> {
  validateGrader(grader);
  const judgments: EvalRubricJudgment[] = [];
  for (const dimension of grader.dimensions) {
    try {
      const judgment = await grader.grade({ ...input, dimension: structuredClone(dimension) });
      validateJudgment(dimension.id, judgment);
      judgments.push(structuredClone(judgment));
    } catch {
      judgments.push({ dimensionId: dimension.id, label: "unknown", reasonCode: "rubric-grader-error" });
    }
  }
  return {
    diagnostic: true,
    provenance: structuredClone(grader.provenance),
    judgments,
  };
}

export function measureRubricAgreement(
  samples: readonly EvalRubricCalibrationSample[],
  policy: EvalRubricCalibrationPolicy = {},
): EvalRubricCalibrationReport {
  const minimumLabelsPerDimension = policy.minimumLabelsPerDimension ?? 5;
  const minimumCoverage = policy.minimumCoverage ?? 0.8;
  const minimumAgreement = policy.minimumAgreement ?? 0.8;
  validateCalibrationPolicy(minimumLabelsPerDimension, minimumCoverage, minimumAgreement);

  const dimensionIds = new Set(samples.flatMap((sample) => Object.keys(sample.humanLabels)));
  for (const sample of samples) {
    if (!sample.sampleId.trim()) throw new Error("Rubric calibration samples require an id");
    for (const label of Object.values(sample.humanLabels)) {
      if (label !== "pass" && label !== "fail") throw new Error(`Invalid human rubric label in sample '${sample.sampleId}'`);
    }
  }
  const byDimension: Record<string, EvalRubricAgreementMetrics> = {};
  for (const dimensionId of [...dimensionIds].sort()) {
    if (!SAFE_ID.test(dimensionId)) throw new Error(`Invalid rubric dimension id '${dimensionId}'`);
    byDimension[dimensionId] = agreementMetrics(
      samples.flatMap((sample) => {
        const human = sample.humanLabels[dimensionId];
        if (human === undefined) return [];
        const model = sample.assessment.judgments.find((judgment) => judgment.dimensionId === dimensionId)?.label ?? "unknown";
        return [{ human, model }];
      }),
      minimumLabelsPerDimension,
      minimumCoverage,
      minimumAgreement,
    );
  }

  const overallPairs = samples.flatMap((sample) => Object.entries(sample.humanLabels).map(([dimensionId, human]) => ({
    human,
    model: sample.assessment.judgments.find((judgment) => judgment.dimensionId === dimensionId)?.label ?? "unknown",
  })));
  const overall = agreementMetrics(
    overallPairs,
    minimumLabelsPerDimension * Math.max(1, dimensionIds.size),
    minimumCoverage,
    minimumAgreement,
  );
  const calibrated = dimensionIds.size > 0 && Object.values(byDimension).every((metrics) => metrics.calibrated);
  return {
    minimumLabelsPerDimension,
    minimumCoverage,
    minimumAgreement,
    calibrated,
    overall: { ...overall, calibrated },
    byDimension,
  };
}

function validateGrader(grader: EvalRubricGrader): void {
  if (grader.dimensions.length === 0) throw new Error("Rubric grader requires at least one dimension");
  const ids = new Set<string>();
  for (const dimension of grader.dimensions) {
    if (!SAFE_ID.test(dimension.id) || ids.has(dimension.id) || !dimension.description.trim()) {
      throw new Error("Rubric dimensions require unique safe ids and descriptions");
    }
    ids.add(dimension.id);
  }
  if (!grader.provenance.provider.trim() || !grader.provenance.model.trim() || !SHA_256.test(grader.provenance.promptHash)) {
    throw new Error("Rubric grader requires pinned provider, model, and SHA-256 prompt provenance");
  }
}

function validateJudgment(dimensionId: string, judgment: EvalRubricJudgment): void {
  if (judgment.dimensionId !== dimensionId) {
    throw new Error(`Rubric grader returned dimension '${judgment.dimensionId}' while grading '${dimensionId}'`);
  }
  if (!isRubricLabel(judgment.label)) throw new Error(`Rubric judgment '${dimensionId}' has an invalid label`);
  if (judgment.reasonCode !== undefined && !SAFE_ID.test(judgment.reasonCode)) {
    throw new Error(`Rubric judgment '${judgment.dimensionId}' has an invalid reason code`);
  }
}

function agreementMetrics(
  pairs: readonly { human: EvalRubricLabel; model: EvalRubricLabel }[],
  minimumLabels: number,
  minimumCoverage: number,
  minimumAgreement: number,
): EvalRubricAgreementMetrics {
  const compared = pairs.filter((pair) => pair.model !== "unknown");
  const agreements = compared.filter((pair) => pair.human === pair.model).length;
  const coverage = pairs.length === 0 ? 0 : compared.length / pairs.length;
  const agreementRate = compared.length === 0 ? 0 : agreements / compared.length;
  return {
    labeled: pairs.length,
    compared: compared.length,
    agreements,
    unknown: pairs.length - compared.length,
    coverage,
    agreementRate,
    calibrated: pairs.length >= minimumLabels && coverage >= minimumCoverage && agreementRate >= minimumAgreement,
  };
}

function validateCalibrationPolicy(minimumLabels: number, minimumCoverage: number, minimumAgreement: number): void {
  if (!Number.isInteger(minimumLabels) || minimumLabels < 1
    || !Number.isFinite(minimumCoverage) || minimumCoverage < 0 || minimumCoverage > 1
    || !Number.isFinite(minimumAgreement) || minimumAgreement < 0 || minimumAgreement > 1) {
    throw new Error("Invalid rubric calibration policy");
  }
}

export function unknownRubricAssessment(grader: EvalRubricGrader, reasonCode: string): EvalRubricAssessment {
  validateGrader(grader);
  if (!SAFE_ID.test(reasonCode)) throw new Error("Invalid rubric unknown reason code");
  return {
    diagnostic: true,
    provenance: structuredClone(grader.provenance),
    judgments: grader.dimensions.map((dimension) => ({
      dimensionId: dimension.id,
      label: "unknown",
      reasonCode,
    })),
  };
}

export function validateRubricGrader(grader: EvalRubricGrader): void {
  validateGrader(grader);
}

function isRubricLabel(value: unknown): value is EvalRubricLabel {
  return value === "pass" || value === "fail" || value === "unknown";
}