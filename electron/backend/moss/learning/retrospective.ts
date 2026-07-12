import type { TerminalRunRecord } from "./run-journal";

const MAX_LESSONS = 5;
const MAX_TEXT_LENGTH = 240;

export interface CandidateLesson {
  id: string;
  provenanceTaskId: string;
  confidence: number;
  scope: string;
  outcome: "positive" | "negative";
  summary: string;
  capabilityIds: string[];
  successCount: number;
  failureCount: number;
  rolledBack: boolean;
}

export interface ConfidenceUpdate {
  confidence: number;
  rolledBack: boolean;
}

export function createRetrospective(record: TerminalRunRecord, maxLessons = MAX_LESSONS): CandidateLesson[] {
  const limit = Math.max(0, Math.min(MAX_LESSONS, Math.floor(maxLessons)));
  if (limit === 0) return [];
  const positive = record.outcome === "completed" && record.criteria.every((criterion) => criterion.passed);
  const outcome: CandidateLesson["outcome"] = positive ? "positive" : "negative";
  const summaries = positive
    ? successfulSummaries(record)
    : unsuccessfulSummaries(record);
  const unique = [...new Set(summaries.map(boundText).filter(Boolean))].slice(0, limit);
  if (unique.length === 0) unique.push(boundText(`${record.objectiveClass}: ${record.outcome}`));

  return unique.map((summary, index) => {
    const successCount = positive ? 1 : 0;
    const failureCount = positive ? 0 : 1;
    const confidence = updateLessonConfidence(successCount, failureCount);
    return {
      id: `${safeId(record.taskId)}-${index + 1}`,
      provenanceTaskId: record.taskId,
      confidence: confidence.confidence,
      scope: boundText(record.objectiveClass),
      outcome,
      summary,
      capabilityIds: [...new Set(record.capabilityIds)].slice(0, 20),
      successCount,
      failureCount,
      rolledBack: confidence.rolledBack,
    };
  });
}

export function updateLessonConfidence(successCount: number, failureCount: number): ConfidenceUpdate {
  requireCount(successCount, "successCount");
  requireCount(failureCount, "failureCount");
  const confidence = Number(((successCount + 1) / (successCount + failureCount + 2)).toFixed(4));
  return {
    confidence,
    rolledBack: failureCount >= 2 && failureCount > successCount,
  };
}

function successfulSummaries(record: TerminalRunRecord): string[] {
  const recovery = record.recoveryChoices.map((choice) => `Effective recovery: ${choice}`);
  const criteria = record.criteria.filter((criterion) => criterion.passed).map((criterion) => `Verified: ${criterion.summary}`);
  return [...recovery, ...criteria];
}

function unsuccessfulSummaries(record: TerminalRunRecord): string[] {
  const failures = record.failures.map((failure) => `Avoid or repair ${failure.category}: ${failure.summary}`);
  const criteria = record.criteria.filter((criterion) => !criterion.passed).map((criterion) => `Unmet criterion: ${criterion.summary}`);
  const attempts = record.attempts
    .filter((attempt) => attempt.result !== "succeeded")
    .map((attempt) => `${attempt.capabilityId} ${attempt.result}: ${attempt.summary}`);
  return [...failures, ...criteria, ...attempts];
}

function boundText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_TEXT_LENGTH ? compact : `${compact.slice(0, MAX_TEXT_LENGTH - 3)}...`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "lesson";
}

function requireCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}