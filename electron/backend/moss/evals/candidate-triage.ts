import { createHash } from "node:crypto";

import type { EvalDatasetSplit } from "../../../../common/evals";
import type { TerminalRunRecord } from "../learning/run-journal";

export interface EvalCandidateReview {
  objectiveApproved: boolean;
  fixtureMinimized: boolean;
  expectedBehaviorApproved: boolean;
  splitApproved: boolean;
  hiddenGraderApproved: boolean;
  reviewer?: string;
  reviewedAt?: string;
}

export interface EvalCandidatePackage {
  schemaVersion: 1;
  id: string;
  status: "draft" | "approved";
  familyCandidate: string;
  failureSignature: string;
  rankScore: number;
  occurrences: number;
  affectedTasks: string[];
  userSignalCount: number;
  traceRefs: NonNullable<TerminalRunRecord["traceRef"]>[];
  proposed: {
    objectiveClass: string;
    split: EvalDatasetSplit;
    provenance: { source: "production"; taskIds: string[] };
  };
  review: EvalCandidateReview;
}

export function createEvalCandidatePackages(records: readonly TerminalRunRecord[]): EvalCandidatePackage[] {
  const clusters = new Map<string, TerminalRunRecord[]>();
  for (const record of records) {
    for (const signature of record.failureSignatures) {
      const key = `${record.taskFamilyCandidate.id}:${signature}`;
      const group = clusters.get(key) ?? [];
      group.push(record);
      clusters.set(key, group);
    }
  }
  return [...clusters.entries()].map(([key, grouped]) => {
    const tasks = [...new Set(grouped.map((record) => record.taskId))].sort();
    const userSignalCount = grouped.reduce((total, record) => total + record.userSignals.length, 0);
    const severeOutcomes = grouped.filter((record) => record.outcome === "failed" || record.outcome === "blocked").length;
    const [familyCandidate, failureSignature] = splitClusterKey(key);
    return {
      schemaVersion: 1,
      id: `candidate-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
      status: "draft",
      familyCandidate,
      failureSignature,
      rankScore: grouped.length * 2 + userSignalCount * 3 + severeOutcomes,
      occurrences: grouped.length,
      affectedTasks: tasks,
      userSignalCount,
      traceRefs: grouped.flatMap((record) => record.traceRef ? [record.traceRef] : []),
      proposed: {
        objectiveClass: grouped[0].objectiveClass,
        split: "development",
        provenance: { source: "production", taskIds: tasks },
      },
      review: emptyReview(),
    } satisfies EvalCandidatePackage;
  }).sort((left, right) => right.rankScore - left.rankScore || left.id.localeCompare(right.id));
}

export function approveEvalCandidate(
  candidate: EvalCandidatePackage,
  reviewer: string,
  reviewedAt = new Date(),
): EvalCandidatePackage {
  const confirmations = [
    candidate.review.objectiveApproved,
    candidate.review.fixtureMinimized,
    candidate.review.expectedBehaviorApproved,
    candidate.review.splitApproved,
    candidate.review.hiddenGraderApproved,
  ];
  if (!confirmations.every(Boolean)) throw new Error("All eval candidate review checks must be confirmed");
  if (!reviewer.trim() || !Number.isFinite(reviewedAt.getTime())) throw new Error("Candidate approval requires a reviewer and valid time");
  return {
    ...structuredClone(candidate),
    status: "approved",
    review: { ...structuredClone(candidate.review), reviewer: reviewer.trim(), reviewedAt: reviewedAt.toISOString() },
  };
}

function emptyReview(): EvalCandidateReview {
  return {
    objectiveApproved: false,
    fixtureMinimized: false,
    expectedBehaviorApproved: false,
    splitApproved: false,
    hiddenGraderApproved: false,
  };
}

function splitClusterKey(key: string): [string, string] {
  const separator = key.lastIndexOf(":");
  return [key.slice(0, separator), key.slice(separator + 1)];
}
