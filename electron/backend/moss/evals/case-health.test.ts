import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkEvalCases } from "./case-health";
import { createOfflinePilotCases } from "./pilot-cases";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("checkEvalCases", () => {
  it("passes the governed pilot references through their hidden validators", async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "moss-health-test-"));
    temporaryDirectories.push(temporaryRoot);
    const report = await checkEvalCases(createOfflinePilotCases(), { temporaryRoot });

    expect(report.valid).toBe(true);
    expect(report.cases).toHaveLength(4);
    expect(report.cases.every((result) => result.passed && result.criteria.every((criterion) => criterion.passed))).toBe(true);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("fails a broken reference solution without invoking a model", async () => {
    const reference = mkdtempSync(join(tmpdir(), "moss-broken-reference-"));
    temporaryDirectories.push(reference);
    writeFileSync(join(reference, "result.json"), '{"status":"wrong"}\n', "utf8");
    const testCase = createOfflinePilotCases()[0];
    testCase.fixture = { ...testCase.fixture, referenceSolution: reference };

    const report = await checkEvalCases([testCase]);

    expect(report).toMatchObject({
      valid: false,
      cases: [{ caseId: testCase.id, passed: false, missingMetadata: [] }],
    });
    expect(report.cases[0].criteria).toEqual([expect.objectContaining({ passed: false })]);
  });

  it("rejects declared families without both positive and negative members", async () => {
    const testCase = createOfflinePilotCases()[0];
    testCase.familyRole = "positive";

    const report = await checkEvalCases([testCase]);

    expect(report.valid).toBe(false);
    expect(report.corpusErrors).toEqual([
      `Family '${testCase.family}' declares familyRole but lacks a positive/negative pair`,
    ]);
  });

  it("enforces immutable lineage when the corpus policy requires it", async () => {
    const testCase = createOfflinePilotCases()[0];

    const report = await checkEvalCases([testCase], { corpusPolicy: { requireDatasetLineage: true } });

    expect(report.valid).toBe(false);
    expect(report.corpusErrors).toContain(`Case '${testCase.id}' lacks dataset lineage`);
  });

  it("detects hidden reference and evaluator contents leaked into the public fixture", async () => {
    const evaluatorRoot = mkdtempSync(join(tmpdir(), "moss-health-evaluator-"));
    const fixtureRoot = mkdtempSync(join(tmpdir(), "moss-health-fixture-"));
    temporaryDirectories.push(evaluatorRoot, fixtureRoot);
    const evaluator = join(evaluatorRoot, "validator.cjs");
    writeFileSync(evaluator, "module.exports = 'hidden';\n", "utf8");
    const testCase = createOfflinePilotCases()[0];
    cpSync(testCase.fixture!.workspaceTemplate!, fixtureRoot, { recursive: true });
    testCase.fixture = { ...testCase.fixture, workspaceTemplate: fixtureRoot };
    writeFileSync(join(fixtureRoot, "leaked-result.json"), '{"status":"ready","items":["alpha","beta"]}', "utf8");
    writeFileSync(join(fixtureRoot, "leaked-validator.cjs"), "module.exports = 'hidden';\n", "utf8");

    const report = await checkEvalCases([testCase], { evaluatorArtifacts: [evaluator] });

    expect(report.valid).toBe(false);
    expect(report.cases[0].leakedArtifacts).toEqual([
      "leaked-result.json duplicates hidden artifact result.json",
      "leaked-validator.cjs duplicates hidden artifact validator.cjs",
    ]);
  });

  it("enforces representative corpus size, domains, source evidence, and matched perturbations", async () => {
    const canonical = createOfflinePilotCases()[0];
    canonical.domain = "platform";
    canonical.provenance = { ...canonical.provenance!, sourceEvidence: "src/lib/settings.test.ts" };
    canonical.perturbation = { class: "canonical", expectedDecision: "same", canonicalCaseId: canonical.id };
    const paraphrase = structuredClone(canonical);
    paraphrase.id = "offline-structured-output-paraphrase";
    paraphrase.perturbation = { class: "paraphrase", expectedDecision: "same", canonicalCaseId: canonical.id };

    const report = await checkEvalCases([canonical, paraphrase], {
      corpusPolicy: {
        minimumCases: 3,
        requiredDomains: ["platform", "browser"],
        minimumBySuite: { regression: 2, capability: 1 },
        requireSourceEvidence: true,
        requirePerturbationPairs: true,
      },
    });

    expect(report.valid).toBe(false);
    expect(report.corpusErrors).toEqual(expect.arrayContaining([
      "Corpus has 2 cases; policy requires at least 3",
      "Corpus lacks required domain 'browser'",
      "Suite 'capability' has 0 cases; policy requires at least 1",
    ]));
    expect(report.corpusErrors).not.toContain(expect.stringContaining("canonical perturbation pair"));
  });

  it("rejects invalid regression promotion metadata", async () => {
    const testCase = createOfflinePilotCases()[0];
    testCase.provenance = {
      ...testCase.provenance!,
      promotion: { from: "capability", reviewedBy: "", reviewedAt: "not-a-date" },
    };

    const report = await checkEvalCases([testCase], { corpusPolicy: {} });

    expect(report.corpusErrors).toContain(`Case '${testCase.id}' has invalid regression promotion metadata`);
  });

  it("blocks publication for a failed grader probe without changing case health", async () => {
    const testCase = createOfflinePilotCases()[0];
    const report = await checkEvalCases([testCase], {
      graderHealthProbes: [{ id: "adversarial-output", run: () => false }],
    });

    expect(report.valid).toBe(true);
    expect(report.cases[0].passed).toBe(true);
    expect(report.graderHealth).toEqual([{ id: "adversarial-output", passed: false }]);
    expect(report.publicationReady).toBe(false);
  });
});