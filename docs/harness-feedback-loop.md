---
title: Harness Feedback Loop
description: Run grounded, provenance-aware Moss prompt evaluations and compare repeated results
ms.date: 2026-08-18
ms.topic: how-to
keywords:
  - evaluation harness
  - prompt evaluation
  - regression testing
  - provenance
estimated_reading_time: 7
---

## Purpose

Use the harness feedback loop to measure one controlled prompt or harness change
against a compatible baseline. Each pilot runs through the production agent loop
in an isolated workspace, then independent validators grade the resulting state.

The default pilot prompt includes the production base and safety instructions.
It excludes mutable memory and installed skills so repeated runs use stable
inputs. It also uses a fixed prompt date, separate from timestamps used to
measure execution. Reports store the prompt profile and a SHA-256 hash of seeded
messages, not the prompt text.

## Evaluation provenance

A report identifies the inputs that affect its result:

* Eval case, model target, and harness variant hashes
* Prompt profile and seeded-message hash for each matrix cell
* Evaluator artifact hash for hidden validator contents
* Check-level verifier IDs, kinds, outcomes, and bounded summaries
* Criterion pass rates across repetitions

Raw model text, tool arguments, tool output, prompt text, and verifier details are
not included in this provenance.

## Choose a corpus and suite

The pilot corpus keeps the original four deterministic regression cases for fast
local checks. The representative corpus contains 24 cases arranged as 12 matched
families. It covers coding, personal, platform, browser, desktop, MCP, approval,
verification, interruption and resume, context pressure, and destructive-action
safety behavior.

Select the representative corpus before running the CLI:

```powershell
$env:MOSS_EVAL_CORPUS = "representative"
npm run eval -- health scripts/eval-pilots.cjs
```

The full corpus health command enforces the inventory, domain coverage, suite
counts, source evidence, canonical pair links, immutable lineage, reference
solutions, and grader probes. A partial suite selection is useful for experiments
but does not claim full-corpus publication readiness:

```powershell
$env:MOSS_EVAL_SUITES = "capability,challenge"
npm run eval -- dry-run scripts/eval-pilots.cjs
```

The suites have separate purposes:

* `regression` protects reviewed behavior that must not degrade
* `capability` measures supported behavior before it becomes a release invariant
* `challenge` explores difficult validation cases without redefining the baseline

Move a case into regression with `promoteCaseToRegression`. Promotion preserves
the case identity and source provenance while recording the prior suite,
reviewer, and review timestamp. It creates a linked case revision when lineage is
present. Do not replace a baseline because a capability or challenge result
improved.

Unset `MOSS_EVAL_SUITES` to restore full-corpus checks in the same PowerShell
session:

```powershell
Remove-Item Env:MOSS_EVAL_SUITES
```

## Interpret perturbations

Every representative family has a canonical case and a matched perturbation or
changed-decision control. Current classes cover paraphrase, irrelevant files,
layout changes, recoverable tool failure, approval denial, compaction,
interruption, and budget exhaustion.

Use `summary.byPerturbationClass` to compare each class independently. Do not
infer perturbation quality from the aggregate pass rate. A class with
`expectedDecision: same` tests invariance. A class with
`expectedDecision: changed` is a control that proves the harness can detect when
the correct decision should move.

## Check grader health

Case health and publication health answer different questions. `valid` means the
corpus metadata and hidden reference solutions pass. `publicationReady` also
requires all adversarial grader probes to pass.

The representative probes cover hidden-answer leakage, protected-path coverage,
hard-coded output, reward-shaped extra fields, output path escape, validator
mutation, and valid alternative JSON key ordering. A failed probe blocks
publication through the CLI exit code. It does not change a case result or score
the grader defect against the agent.

## Triage production signals

Terminal runs write schema-versioned records under the local application data
root in `learning/runs`. Default records contain bounded objective classes,
capability and outcome metadata, typed user signals, verification outcomes,
stable failure signatures, and optional trace hashes. They do not retain prompts,
transcripts, raw tool arguments, or raw tool output.

Failure signatures identify a mechanism using category, capability, and a reason
code or normalized bounded summary. Changing a path, duration, or other numeric
detail does not create a new mechanism cluster. Rich local artifacts require an
explicit `retainRichArtifacts` option and still pass through recursive credential
redaction.

Generate ranked draft packages from a local journal root:

```powershell
npm run eval -- triage C:\path\to\moss-user-data reports\eval-candidates.json
```

Triage clusters records by task-family candidate and failure mechanism. Frequency,
failed or blocked outcomes, and typed user correction signals determine rank.
Generated packages remain drafts and contain production task IDs for provenance;
they are not executable eval cases.

Before approval, a human reviewer must confirm the objective, minimized fixture,
expected behavior, dataset split, and hidden grader. `approveEvalCandidate`
refuses approval until all five checks are true and a reviewer and review time are
recorded.

## Govern dataset lineage

Every representative case has a content hash, family root, revision number, and
revision ID. Use `reviseEvalCase` to change governed content. The new revision
links to its parent and can record the source production task and failure
signature. Editing governed content without advancing the revision fails corpus
health.

Lineage health rejects a family that appears in both holdout and non-holdout
splits, including generated perturbations with different case IDs. It also emits
Jaccard-similarity warnings for near-duplicate objectives assigned to nominally
different families. Duplicate warnings require review but do not alter agent
scores or silently merge cases.

## Run a smoke evaluation

Set the provider variables when the defaults do not point to the intended local
OpenAI-compatible endpoint:

```powershell
$env:MOSS_EVAL_BASE_URL = "http://localhost:11434/v1"
$env:MOSS_EVAL_MODEL = "qwen3:8b"
```

Inspect the matrix before invoking the model:

```powershell
npm run eval -- dry-run scripts/eval-pilots.cjs
```

Run one repetition per case for a local smoke report:

```powershell
$env:MOSS_EVAL_REPETITIONS = "1"
npm run eval -- run scripts/eval-pilots.cjs reports/pilot-candidate.json
```

## Run a release comparison

Use at least three repetitions per case for a prompt or release decision:

```powershell
$env:MOSS_EVAL_REPETITIONS = "3"
npm run eval -- run scripts/eval-pilots.cjs reports/pilot-candidate.json
```

Compare the candidate with a baseline under the checked-in resource tolerance
policy:

```powershell
npm run eval -- diff reports/pilot-baseline.json reports/pilot-candidate.json --policy reports/pilot-thresholds.json
```

Completion, security, and criterion pass-rate regressions remain hard failures.
The policy can tolerate bounded changes in tokens, cost, duration, actions, and
process scores. Prompt hash changes are reported but are not failures by
themselves because a prompt experiment is expected to change that hash.

## Compare Phase 5 runtime controls

Select the matched Phase 5 experiment before a dry run or evaluation:

```powershell
$env:MOSS_EVAL_EXPERIMENT = "phase5-runtime"
npm run eval -- dry-run scripts/eval-pilots.cjs
```

The `phase5-baseline` and `phase5-candidate` variants use the same model,
approval setting, round limit, and execution budget. Their complete runtime
control blocks are included in the variant-set hash. Matrix validation rejects
an invalid control value or any comparison whose variant budgets differ.

The candidate changes five harness-owned controls:

* Compact context instead of retaining the full conversation
* Dependency-ready incremental planning instead of free-form planning
* Verification after mutation instead of terminal-only verification
* Signature-aware recovery instead of standard retries
* A tool-free diagnostic reviewer pass after the primary turn

Durable tasks project a bounded progress packet into each attempt. The packet
contains acceptance criteria, the selected dependency-ready step, latest
passing evidence, unresolved failures, changed files, the latest successful
turn checkpoint, baseline status, and the next action. Durable task state is
authoritative. Model output cannot select a blocked step or mark a criterion as
verified.

Recovery reporting is separate from completion reporting. Aggregate metrics
include recovery attempts, successful recoveries, recovery success rate, and
attempt counts by failure classification. A repeated failed action signature
forces replanning instead of permitting the same terminal action again.

The reviewer receives the objective, acceptance criteria, and primary response.
It receives no tools or hidden reference solution. Reports retain only its
structured label, reason code, token usage, estimated cost, and duration.

> [!IMPORTANT]
> The reviewer is diagnostic and cannot change completion, evidence, failure
> attribution, or release gates. Adopt it beyond experiments only when paired
> runs show a calibrated judgment gain that exceeds its token, cost, and latency
> overhead without regressing deterministic outcomes.

Restore the approval experiment in the same PowerShell session:

```powershell
$env:MOSS_EVAL_EXPERIMENT = "approval"
```

## Scale and resume matrix runs

Set global and provider-specific limits before a provider run:

```powershell
$env:MOSS_EVAL_CONCURRENCY = "4"
$env:MOSS_EVAL_PROVIDER_CONCURRENCY = "2"
npm run eval -- run scripts/eval-pilots.cjs reports/candidate.json --resume reports/candidate.progress.json
```

Each matrix cell retains its own temporary workspace. The runner schedules at
most the configured global number of cells and separately limits calls sharing a
provider ID. Cancellation reaches pending workers and active production turns.
An executor startup exception becomes an explicit harness-orchestration failure
cell, not a model failure and not a silently retried trial.

The progress file is schema-versioned and written through atomic replacement.
Resume accepts only cells whose evaluator, case, target, and variant hashes match
the requested matrix. Duplicate, unknown, malformed, or incompatible progress is
rejected. The final report restores canonical matrix order regardless of worker
completion order.

## Exchange portable datasets

Export configured cases to the bounded Moss interchange format:

```powershell
npm run eval -- dataset-export scripts/eval-pilots.cjs reports/portable-cases.json
```

Validate and import that format into a native case bundle:

```powershell
npm run eval -- dataset-import reports/portable-cases.json reports/imported-cases.json
```

The portable format carries task specifications, allowed capabilities,
deterministic checks, repetitions, and tags. It intentionally excludes local
fixture paths, hidden reference solutions, dataset governance, provider
credentials, and executor code. Imported cases pass the native Moss validator.
Inspect or Harbor bridges should translate through this boundary rather than
becoming core Python or Docker dependencies.

## Run container-backed external tasks

`DockerEvalSandboxBackend` and `createSandboxEvalExecutor` provide an opt-in
backend for high-risk terminal benchmarks. They are not used by the default
temporary-workspace pilots. The Docker invocation disables networking, mounts
only the isolated workspace, uses a read-only container root, drops Linux
capabilities, prevents privilege escalation, and applies memory, CPU, process,
and time limits.

Container stdout and stderr do not enter reports. A nonzero command exit records
a bounded execution failure, while Docker startup failures flow to matrix-level
infrastructure accounting. Native Moss checks still grade workspace end state.

> [!IMPORTANT]
> Keep results labeled by executor and sandbox backend. Do not pool container,
> external scaffold, and native Moss scores as measurements of one system.

## Use CI evaluation tiers

The checked-in workflows separate cost and confidence:

* `ci.yml` runs typecheck, deterministic tests, production build, and no-model
   representative corpus and grader health on pull requests and `main`
* `eval-provider-smoke.yml` runs a one-repetition resumable pilot matrix nightly
   or on demand and uploads its reports
* `eval-release.yml` runs the representative repeated matrix on demand, compares
   it with a supplied compatible baseline, and uploads candidate and diff reports

Provider endpoints and model names use repository variables. API keys use GitHub
secrets and are never written into reports or workflow artifacts.

## Add diagnostic rubric grading

Set `rubricGrader` in `HarnessEvalConfig` when a trial needs semantic assessment
that deterministic checks cannot decide. Supported dimensions include
instruction following, communication quality, over-engineering, and trajectory
quality. The provider-backed `createModelRubricGrader` adapter sends one request
per dimension and requires an exact JSON response containing `label` and an
optional machine-safe `reasonCode`.

Rubric labels are `pass`, `fail`, or `unknown`. A malformed response, provider
failure, or invalid reason code changes only that dimension to `unknown`. It does
not erase successful judgments from other dimensions.

Each persisted assessment includes the grader provider, model, and SHA-256 hash
of the exact prompt template. Reports retain categorical labels and reason codes,
but not the model response submitted to the grader or the grader's raw output.

> [!IMPORTANT]
> Rubric assessments are diagnostic. They do not change trial success, failure
> attribution, release policy, or deterministic criterion scores.

Add `rubricCalibration` to the same configuration to compare current assessments
with human labels. Human uncertainty is represented by omitting a dimension, not
by labeling it `unknown`. The report includes labeled count, model coverage,
exact agreement, and `unknown` count for each dimension. A calibration is marked
complete only when every labeled dimension meets the configured minimum sample,
coverage, and agreement thresholds.

Calibration status is also diagnostic. Enabling a future rubric-based release
gate requires a separate policy change and a reviewed human-labeled set; the
current release comparison ignores rubric labels and calibration status.

## Change discipline

1. Freeze the cases, model target, harness controls, validators, and repetition
   count.
2. Run and retain the baseline report.
3. Change one prompt or harness variable.
4. Run the candidate with the same matrix and repetition count.
5. Inspect criterion, completion, security, process, and resource deltas.
6. Reject the candidate when a hard gate regresses.
7. Replace the baseline only after the candidate passes and the changed prompt
   provenance is understood.

A changed validator artifact invalidates compatibility instead of presenting a
scoring change as a model improvement. A changed case, target, or harness variant
has the same effect.

## Scope boundary

The workflow adapts two ideas from the July 2026 working note *Knowledge Graph
Engineering for Multi-Agentic Systems: The Anthropic Playbook*: rerun a scorer
after a prompt change, and ground evaluation in extracted or verified facts. The
note is an independent synthesis and is not affiliated with or endorsed by
Anthropic.

Moss does not add subject-predicate-object extraction, entity resolution, graph
storage, graph traversal, or stage-specific model routing to its evaluation
harness. Those mechanisms solve knowledge-graph problems rather than harness
measurement problems.
