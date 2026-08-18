import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { EvalCase, EvalProductDomain, EvalSuitePurpose } from "../../../../common/evals";
import { VerificationRegistry } from "../verify/verification-registry";
import { validateDatasetLineage, type EvalDuplicateWarning } from "./dataset-lineage";
import { collectEvalEvidence, validateCase } from "./eval-runner";

export interface EvalCaseHealthResult {
  caseId: string;
  passed: boolean;
  missingMetadata: string[];
  leakedArtifacts: string[];
  criteria: Array<{ criterionId: string; mandatory: boolean; passed: boolean }>;
  error?: string;
}

export interface EvalCaseHealthReport {
  valid: boolean;
  publicationReady: boolean;
  corpusErrors: string[];
  corpusWarnings: EvalDuplicateWarning[];
  cases: EvalCaseHealthResult[];
  graderHealth: EvalGraderHealthResult[];
}

export interface EvalGraderHealthProbe {
  id: string;
  run: () => boolean | Promise<boolean>;
}

export interface EvalGraderHealthResult {
  id: string;
  passed: boolean;
  error?: string;
}

export interface EvalCaseHealthOptions {
  temporaryRoot?: string;
  registry?: VerificationRegistry;
  evaluatorArtifacts?: string[];
  corpusPolicy?: EvalCorpusPolicy;
  graderHealthProbes?: EvalGraderHealthProbe[];
}

export interface EvalCorpusPolicy {
  minimumCases?: number;
  requiredDomains?: EvalProductDomain[];
  minimumBySuite?: Partial<Record<EvalSuitePurpose, number>>;
  requireSourceEvidence?: boolean;
  requirePerturbationPairs?: boolean;
  requireDatasetLineage?: boolean;
}

/** Proves that governed cases have solvable fixtures and working independent graders. */
export async function checkEvalCases(
  cases: readonly EvalCase[],
  options: EvalCaseHealthOptions = {},
): Promise<EvalCaseHealthReport> {
  const results: EvalCaseHealthResult[] = [];
  const registry = options.registry ?? new VerificationRegistry();
  const lineageHealth = validateDatasetLineage(cases);
  const corpusErrors = [
    ...validateDeclaredFamilyBalance(cases),
    ...validateCorpusPolicy(cases, options.corpusPolicy),
    ...(options.corpusPolicy?.requireDatasetLineage ? lineageHealth.errors : []),
  ].sort();

  for (const testCase of cases) {
    const missingMetadata = requiredMetadata(testCase);
    let leakedArtifacts: string[] = [];
    const workspaceRoot = mkdtempSync(join(options.temporaryRoot ?? tmpdir(), "moss-eval-health-"));
    try {
      validateCase(testCase);
      const template = testCase.fixture?.workspaceTemplate;
      const reference = testCase.fixture?.referenceSolution;
      if (!template || !reference) {
        results.push({
          caseId: testCase.id,
          passed: false,
          missingMetadata,
          leakedArtifacts,
          criteria: [],
          error: "Case health requires workspaceTemplate and referenceSolution fixtures",
        });
        continue;
      }
      leakedArtifacts = findHiddenArtifactLeaks(template, [reference, ...(options.evaluatorArtifacts ?? [])]);
      cpSync(template, workspaceRoot, { recursive: true });
      cpSync(reference, workspaceRoot, { recursive: true });
      const evidence = await collectEvalEvidence(
        testCase,
        workspaceRoot,
        new AbortController().signal,
        { registry },
      );
      const criteria = testCase.task.acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        mandatory: criterion.mandatory,
        passed: evidence.find((item) => item.criterionId === criterion.id)?.passed ?? false,
      }));
      const mandatoryPassed = criteria.filter((criterion) => criterion.mandatory).every((criterion) => criterion.passed);
      results.push({
        caseId: testCase.id,
        passed: missingMetadata.length === 0 && leakedArtifacts.length === 0 && mandatoryPassed,
        missingMetadata,
        leakedArtifacts,
        criteria,
      });
    } catch (error) {
      results.push({
        caseId: testCase.id,
        passed: false,
        missingMetadata,
        leakedArtifacts,
        criteria: [],
        error: boundedError(error),
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  const graderHealth = await runGraderHealthProbes(options.graderHealthProbes ?? []);
  const valid = corpusErrors.length === 0 && results.every((result) => result.passed);
  return {
    valid,
    publicationReady: valid && graderHealth.every((result) => result.passed),
    corpusErrors,
    corpusWarnings: lineageHealth.duplicateWarnings,
    cases: results,
    graderHealth,
  };
}

async function runGraderHealthProbes(probes: readonly EvalGraderHealthProbe[]): Promise<EvalGraderHealthResult[]> {
  const results: EvalGraderHealthResult[] = [];
  for (const probe of probes) {
    try {
      const passed = await probe.run();
      results.push({ id: probe.id, passed });
    } catch (error) {
      results.push({ id: probe.id, passed: false, error: boundedError(error) });
    }
  }
  return results;
}

function validateDeclaredFamilyBalance(cases: readonly EvalCase[]): string[] {
  const rolesByFamily = new Map<string, Set<string>>();
  for (const testCase of cases) {
    if (!testCase.familyRole || !testCase.family) continue;
    const roles = rolesByFamily.get(testCase.family) ?? new Set<string>();
    roles.add(testCase.familyRole);
    rolesByFamily.set(testCase.family, roles);
  }
  return [...rolesByFamily.entries()]
    .filter(([, roles]) => !roles.has("positive") || !roles.has("negative"))
    .map(([family]) => `Family '${family}' declares familyRole but lacks a positive/negative pair`)
    .sort();
}

export function findHiddenArtifactLeaks(template: string, hiddenPaths: readonly string[]): string[] {
  const templateRoot = realpathSync(template);
  const templateFiles = filesUnder(templateRoot);
  const templateHashes = new Map<string, string[]>();
  for (const file of templateFiles) {
    const hash = fileHash(file);
    if (!hash) continue;
    const paths = templateHashes.get(hash) ?? [];
    paths.push(relative(templateRoot, file).replace(/\\/g, "/"));
    templateHashes.set(hash, paths);
  }

  const leaks = new Set<string>();
  for (const hiddenPath of hiddenPaths) {
    const hiddenRoot = realpathSync(hiddenPath);
    if (isWithin(templateRoot, hiddenRoot) || isWithin(hiddenRoot, templateRoot)) {
      leaks.add(`${basename(hiddenRoot)} overlaps the public workspace template`);
    }
    for (const file of filesUnder(hiddenRoot)) {
      const hash = fileHash(file);
      if (!hash) continue;
      for (const publicPath of templateHashes.get(hash) ?? []) {
        leaks.add(`${publicPath} duplicates hidden artifact ${basename(file)}`);
      }
    }
  }
  return [...leaks].sort();
}

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : entry.isFile() ? [child] : [];
  });
}

function fileHash(path: string): string | undefined {
  const content = readFileSync(path);
  return content.length === 0 ? undefined : createHash("sha256").update(content).digest("hex");
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..");
}

function requiredMetadata(testCase: EvalCase): string[] {
  const missing: string[] = [];
  if (!testCase.suite) missing.push("suite");
  if (!testCase.split) missing.push("split");
  if (!testCase.family) missing.push("family");
  if (!testCase.provenance) missing.push("provenance");
  else if (!testCase.provenance.referenceSolutionVerified) missing.push("provenance.referenceSolutionVerified");
  return missing;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function validateCorpusPolicy(cases: readonly EvalCase[], policy?: EvalCorpusPolicy): string[] {
  if (!policy) return [];
  const errors: string[] = [];
  if (policy.minimumCases !== undefined && cases.length < policy.minimumCases) {
    errors.push(`Corpus has ${cases.length} cases; policy requires at least ${policy.minimumCases}`);
  }
  for (const domain of policy.requiredDomains ?? []) {
    if (!cases.some((testCase) => testCase.domain === domain)) errors.push(`Corpus lacks required domain '${domain}'`);
  }
  for (const [suite, minimum] of Object.entries(policy.minimumBySuite ?? {})) {
    const count = cases.filter((testCase) => testCase.suite === suite).length;
    if (minimum !== undefined && count < minimum) {
      errors.push(`Suite '${suite}' has ${count} cases; policy requires at least ${minimum}`);
    }
  }
  if (policy.requireSourceEvidence) {
    for (const testCase of cases) {
      if (!testCase.provenance?.sourceEvidence?.trim()) {
        errors.push(`Case '${testCase.id}' lacks source evidence`);
      }
    }
  }
  for (const testCase of cases) {
    const promotion = testCase.provenance?.promotion;
    if (!promotion) continue;
    if (testCase.suite !== "regression" || !promotion.reviewedBy.trim() || !Number.isFinite(Date.parse(promotion.reviewedAt))) {
      errors.push(`Case '${testCase.id}' has invalid regression promotion metadata`);
    }
  }
  if (policy.requirePerturbationPairs) errors.push(...validatePerturbationPairs(cases));
  return errors;
}

function validatePerturbationPairs(cases: readonly EvalCase[]): string[] {
  const errors: string[] = [];
  const casesById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  for (const testCase of cases) {
    const perturbation = testCase.perturbation;
    if (!perturbation) {
      errors.push(`Case '${testCase.id}' lacks perturbation metadata`);
      continue;
    }
    const canonical = casesById.get(perturbation.canonicalCaseId);
    if (!canonical) {
      errors.push(`Case '${testCase.id}' references missing canonical case '${perturbation.canonicalCaseId}'`);
      continue;
    }
    if (canonical.family !== testCase.family || canonical.perturbation?.class !== "canonical") {
      errors.push(`Case '${testCase.id}' has an invalid canonical perturbation pair`);
    }
  }
  return errors;
}