---
title: Harness Feedback Loop
description: Run grounded, provenance-aware Moss prompt evaluations and compare repeated results
ms.date: 2026-09-05
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
* Execution selection, source corpus case IDs, and excluded cases with reasons
* Execution purpose, release measurement name, and source split-corpus hash

Raw model text, tool arguments, tool output, prompt text, and verifier details are
not included in this provenance.

## Choose a corpus and suite

The pilot corpus keeps the original four deterministic regression cases for fast
local checks. The representative corpus contains 26 cases arranged as 13 matched
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
solutions, and grader probes. Health always checks the full selected corpus,
independently of execution or suite filters, and reports `healthScope: corpus`.
A partial execution selection is useful for experiments but does not provide full
release coverage:

```powershell
$env:MOSS_EVAL_SUITES = "capability,challenge"
npm run eval -- dry-run scripts/eval-pilots.cjs
```

The suites have separate purposes:

* `regression` protects reviewed behavior that must not degrade
* `capability` measures supported behavior before it becomes a release invariant
* `challenge` explores difficult validation cases without redefining the baseline

Move a non-production case into regression with `promoteCaseToRegression`. Promotion preserves
the case identity and source provenance while recording the prior suite,
reviewer, and review timestamp. It creates a linked case revision when lineage is
present. Do not replace a baseline because a capability or challenge result
improved.

Unset `MOSS_EVAL_SUITES` to include all suites in the same PowerShell
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

Author production-derived families through the TypeScript API in
`electron/backend/moss/evals/candidate-triage.ts`:

1. Pass the candidate and authored cases to `createEvalFamilyDraft`. This retains
  source task IDs and optional trace references, resets review confirmations,
  and assigns a shared family root, development split, and capability suite.
2. Supply a minimized public fixture and a hidden known-good reference for every
  member, with both `familyRole: positive` and `familyRole: negative` represented.
  Each case needs independent acceptance checks. The reviewer must establish
  that the negative member is a meaningful control, not merely another task.
3. Confirm all five review fields on `draft.candidate.review`. Call
  `approveEvalFamilyDraft(draft, reviewer, options)` with `evaluatorArtifacts`
  naming the actual hidden grader files and `graderHealthProbes` exercising
  positive acceptance and negative-control rejection. Existing case health runs
  the references, checks grader leakage, and rejects failed probes.
4. Review the returned approved package. Approval leaves cases in capability.
  Explicitly call `promoteEvalFamilyToRegression(approved, reviewer, options)`
  when ready: it reruns health and returns linked regression revisions for the
  entire family. It does not modify the package, corpus files, or baseline.

The single-case promotion helper rejects production cases. Candidate approval
alone is not case publication. These authoring operations are API-only; retain
the draft and approved packages locally in your authoring workflow. Fixture
minimization, control meaning, and whether supplied grader files/probes are the
right ones remain human review obligations. Grader code and authoring configs
are trusted inputs, not sandboxed or independently certified by these checks.

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
scores or silently merge cases. At execution time, any such near-duplicate
crossing the holdout boundary is a blocking error, including cases excluded from
the requested run. The existing detector uses objective-token Jaccard similarity
at 0.82, not semantic equivalence; paraphrases below that threshold still require
human leakage review.

`MOSS_EVAL_PURPOSE` controls the dataset split separately from suites and execution
capabilities:

* `iteration` is the default and selects development cases only
* `promotion` selects validation cases for promotion-decision measurements
* `release` permits all splits and requires a nonblank `MOSS_EVAL_MEASUREMENT`

Holdout cases cannot execute for iteration or promotion and must have valid
lineage. Matrix preflight and both evaluation runners enforce purpose before
executor calls. Source family names and lineage/canonical roots cannot cross
holdout boundaries. Custom filtered configs must supply the complete source
corpus in `healthCases` (or runner option `corpusCases`); checks cannot discover
undeclared datasets. Legacy cases without a split are treated as development.
Legacy exports that already discarded split metadata need a provenance review
before reuse; that metadata cannot be reconstructed automatically.

Reports record execution purpose and measurement name. Comparisons require the
same purpose and source split-corpus hash; two named releases may have different
names. Resume additionally requires the exact same measurement name. Use a new
progress file for a new release measurement. Release CI assigns a name from its
workflow run ID and attempt; no dispatch or baseline promotion is automatic.

## Human duration and saturation

Cases may declare `estimatedHumanMinutes` (finite and positive) and
`taskMessiness` (`low`, `medium`, or `high`). Estimate a qualified human's task
completion time; messiness is an author rating of ambiguity, incomplete context,
and environmental setup burden. Neither field is measured agent runtime. Govern
changes through case revisions rather than inferring values from model results.

`summary.corpusDiagnostics` reports each target/variant separately. Human-duration
buckets are up to 5 minutes, over 5 through 30, over 30 through 120, over 120, and
`unknown`. Each bucket reports distinct cases, trials, successes, and the trial
success rate; empty buckets have a null rate. Missing estimates are never zero.

Capability saturation is a diagnostic signal, not a release gate or a claim
about general intelligence. It requires explicit full-corpus coverage, at least
10 capability cases across 5 named families, at least 3 distinct repetitions per
case, no harness-attributed failures, and case-averaged success of at least 0.95.
Filtered runs, missing cases, repeated repetition IDs, and insufficient samples
report `insufficient-support`. The current six-case capability suite therefore
cannot establish saturation. Use a signal to commission harder or longer tasks,
not to promote a baseline or erase existing tests.

## Run a smoke evaluation

Set the provider variables when the defaults do not point to the intended local
OpenAI-compatible endpoint:

```powershell
$env:MOSS_EVAL_BASE_URL = "http://localhost:11434/v1"
$env:MOSS_EVAL_MODEL = "qwen3:8b"
```

The default `MOSS_EVAL_EXECUTION=local` with `MOSS_EVAL_PURPOSE=iteration` runs
three pilot cases or 20 representative development cases without Docker.
Here, `local` describes execution capabilities, not the
provider location. Your configured model endpoint is still required for a run.
Selection excludes whole cases requiring `run_command` or enabled verification;
it never removes capabilities from a case. The pilot excludes one coding case;
representative excludes that case and its paraphrase. The default purpose also
excludes four validation cases. A named release with `local` selects 24 of 26
representative cases, but is still partial evidence.

The execution selection is independent of `MOSS_EVAL_SUITES`:

* `local` selects cases that do not require container execution (the default)
* `container` selects only cases requiring container execution
* `full` includes both groups, subject to suite and purpose/split filters

Set `MOSS_EVAL_EXECUTION` to `container` or `full` to include command cases. Before
dry-run, preflight, or execution of those cases, configure an approved
`MOSS_EVAL_SANDBOX_IMAGE` pinned as
`repository@sha256:<64 lowercase hex characters>` and provision that exact image.
Missing pins never trigger a host-shell fallback. See
[Container-backed evaluations](#container-backed-evaluations) for prerequisites.
No-model health and dataset export do not require an image. Dataset export uses
the execution and purpose selections; set `full` and a named release purpose to
export all cases without invoking a model.
Custom configs can provide `validateExecution()` for execution-only prerequisites;
the CLI calls it before dry-run, preflight, and run, but not health.

Inspect the matrix before invoking the model:

```powershell
npm run eval -- dry-run scripts/eval-pilots.cjs
```

Run one repetition per case for a local smoke report:

```powershell
$env:MOSS_EVAL_REPETITIONS = "1"
npm run eval -- run scripts/eval-pilots.cjs reports/pilot-candidate.json
```

Dry-run and run print `executionCoverage`, also retained in report and progress
manifests. Each exclusion names its case and reason: `requires-container`,
`local-case`, `suite-filter`, or `split-filter`. A selected-out case is not a failed trial.
Changing selection or exclusions invalidates report and resume compatibility.
Equivalent partial reports can be compared without a full-coverage policy.

## Run a release comparison

Release evidence requires `full`, no suite exclusions, a provisioned container
image, and a compatible full representative baseline. Use at least three
repetitions per case. Set `$baseline` to the reviewed baseline path before these
commands:

```powershell
$env:MOSS_EVAL_CORPUS = "representative"
$env:MOSS_EVAL_EXECUTION = "full"
$env:MOSS_EVAL_PURPOSE = "release"
$env:MOSS_EVAL_MEASUREMENT = "release-candidate-2026-09-05"
$env:MOSS_EVAL_EXPERIMENT = "phase5-runtime"
Remove-Item Env:MOSS_EVAL_SUITES -ErrorAction SilentlyContinue
$env:MOSS_EVAL_REPETITIONS = "3"
npm run eval -- preflight scripts/eval-pilots.cjs $baseline --policy reports/pilot-thresholds.json
npm run eval -- run scripts/eval-pilots.cjs reports/release-candidate.json
```

Compare the candidate with a baseline under the checked-in resource tolerance
policy:

```powershell
npm run eval -- diff $baseline reports/release-candidate.json --policy reports/pilot-thresholds.json
```

The checked-in policy sets `requireFullCoverage: true`. Partial reports and
legacy reports without explicit coverage cannot satisfy this policy, even if
their selected trials all pass. The legacy pilot baseline is not a compatible
full representative release baseline. Review and generate new full evidence;
do not relabel a partial report to bypass the gate.

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

Infrastructure retries are off by default. To retry only cells marked
`matrix-cell-infrastructure-error` in compatible progress, set
`MOSS_EVAL_RETRY_INFRASTRUCTURE=1` before the same resumable command. Custom
configs can set `matrix.retryInfrastructureFailures: true`. Agent and grader
failures are not retried by this option.

A retry replaces the scored cell at the same repetition index. Its
`infrastructureRetries` records prior run IDs, completion timestamps, and any
diagnostic references; it does not add independent statistical samples. Original
error details require opt-in diagnostics. Retain the progress file and its
referenced diagnostic artifacts to preserve this history.

## Capture private trial diagnostics

Diagnostic capture is off by default. Enable it for a local run with a separate
directory outside your checkout, shared folders, and CI artifact paths:

```powershell
$diagnostics = Join-Path $env:LOCALAPPDATA "MossEvalDiagnostics\candidate"
npm run eval -- run scripts/eval-pilots.cjs reports/candidate.json --diagnostics-dir $diagnostics
```

The production turn executor captures provider messages, tool arguments and
results, approval comments, verification details, and provider errors. Custom
executor factories must forward `context.diagnostics` to
`createTurnEvalExecutor()` to capture that trajectory. The matrix always adds
trial identity and evaluator results when capture is enabled; those summaries
alone do not establish a complete model trajectory.

Each compact cell stores only a schema-versioned diagnostic reference and a
SHA-256 digest. Diagnostic artifacts use immutable content-addressed JSON files
with atomic publication, deduplicated sanitized payloads, a 2 MiB artifact cap,
a 64 KiB payload cap, and at most 1,024 events. Traversal limits and omitted
content set `truncated`. Response text is sanitized after assembly rather than
stored as fragments that might split credentials across events.

Resuming with capture enabled requires every completed cell to have a valid
artifact in the explicitly selected store. A missing or altered artifact fails
the run; old transcripts cannot be reconstructed. Use a fresh progress file to
capture a run that previously had diagnostics disabled. Storage failures also
fail the run instead of silently dropping requested diagnostics.

> [!WARNING]
> Artifacts and detailed exports remain sensitive. Recursive credential
> redaction is pattern-based, not a guarantee that arbitrary prose is secret-free.
> Keep secrets out of case and variant configuration, including verification
> commands, because reproducibility manifests retain configuration. Choose a
> private directory and restrict its Windows ACLs; POSIX file modes alone do not
> secure Windows storage. No encryption, automatic expiry, or cloud upload is
> provided. Delete the dedicated directory and detailed exports when review ends.

The release workflow does not enable capture and uploads only its three explicit
compact report paths. Do not add diagnostic directories or detailed exports to
that upload list.

## Inspect captured trials

Select exactly one trial and explicitly supply the store to include its details:

```powershell
npm run eval -- inspect reports/candidate.json --case CASE_ID --target TARGET_ID --variant VARIANT_ID --repetition 0 --diagnostics-dir $diagnostics
$inspection = Join-Path $diagnostics "review.html"
npm run eval -- export reports/candidate.json $inspection --case CASE_ID --target TARGET_ID --variant VARIANT_ID --repetition 0 --format html --diagnostics-dir $diagnostics
```

Without `--diagnostics-dir`, inspection remains compact and never opens an
artifact. With it, reads validate the file digest, payload references, and schema;
missing or tampered files fail explicitly. HTML escapes captured content and
places outcome checks beside the expanded trajectory, stacking them on narrow
screens. No remote assets or scripts are loaded.

Review signals flag undelivered disturbances, truncated captures, missing
provider requests, and disagreements between claimed completion and evaluator
outcome. A disagreement invites inspection; it does not establish grader error
or change a release gate. Digests detect changes relative to a reference, not
authorship or tampering with both the reference and artifact by a local actor.

Human corrections are available through the TypeScript store API:
`store.recordCorrection(originalReference, correction)`. Supply `reviewedBy`,
`reason`, and at least one of `success`, `score` (0 to 1), or `failureCategory`.
The returned reference identifies a new sanitized artifact linked to the
original digest, with a unique ID and timestamp. Retain each returned reference
as review history; there is no automatic correction discovery or CLI editing.

Pass those references to
`inspectHarnessTrial(report, selector, baseline, { store, corrections })` to
include them in JSON or HTML inspection. References for another trial are
rejected. Corrections are annotations only: original reports, scores, and release
decisions are never rewritten or recomputed from them.

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
deterministic checks, repetitions, tags, split/suite/family identity, lineage,
scenario and benchmark controls, and optional human-duration/messiness metadata.
It intentionally excludes local fixture paths, hidden reference solutions,
production source provenance, provider credentials, and executor code. Imported
cases pass the native Moss validator; holdout identity survives round-trip and
still requires named release execution. Reattach reviewed fixtures and provenance
before corpus publication. Check commands may themselves contain local paths or
sensitive configuration: inspect an export before sharing it.
Inspect or Harbor bridges should translate through this boundary rather than
becoming core Python or Docker dependencies.

## Container-backed evaluations

`createTurnEvalExecutor()` routes `run_command` and enabled verification commands
through `DockerEvalSandboxBackend`. There is no host-shell fallback. Configure
`variant.sandbox.image` with a digest-pinned Linux image containing `/bin/sh` and
the tools required by the case. The pilot script reads this from
`MOSS_EVAL_SANDBOX_IMAGE`. Docker must already have the exact image locally;
execution uses `--pull never`.

The reviewed host tool set is `read_file`, `write_file`, `edit_file`, `move_file`,
`list_dir`, `glob_files`, `search_files`, and `plan`. Other capability names,
including Git and delegation, fail before provider calls until an adapter exists.
Custom tool implementations and custom matrix executors remain trusted code;
these restrictions do not sandbox arbitrary JavaScript supplied by a config.
`createSandboxEvalExecutor()` remains available for standalone external commands.

Each command gets a fresh named container with only the temporary workspace
mounted writable at `/workspace`. Files persist across commands within a cell;
processes, shell variables, and changes outside the mount do not. Commands use
Linux syntax even on a Windows host. The root filesystem is read-only, Linux
capabilities are dropped, and privilege escalation is disabled. Defaults are
512 MiB memory with no additional swap, one CPU, 128 processes, and a 180-second
backend timeout; the production terminal tool supplies its own shorter timeout.
Stdout and stderr are each capped at 8,000 characters and Docker logging is off.

Networking defaults to `none`. `variant.sandbox.allowNetwork: true`, or
`MOSS_EVAL_SANDBOX_NETWORK=bridge` for pilots, explicitly enables Docker bridge
networking and changes the variant hash. This is unrestricted egress, not an
allowlist. Provider requests occur in the host process independently of this
container network setting; provider credentials are not passed into containers.

Before host tools run and after commands finish, the executor rejects workspace
symlinks, hard-linked files, special files, linked roots, and trees above 20,000
entries. A rejected workspace stays unusable for the rest of the turn and cannot
reach end-state graders through this executor. Fixtures and hidden validators
remain trusted inputs. Concurrent hostile host processes and Docker-engine or
kernel exploits are outside this boundary. Writable workspace disk usage is not
quota-limited; use dedicated evaluation storage and monitor free space.

Cancellation and timeout trigger named `docker rm --force` cleanup with a fresh
30-second deadline. If cleanup cannot be confirmed, the matrix stops scheduling,
waits for active workers, and retains the affected workspace. Resolve the named
container in Docker before deleting that workspace or resuming. Ordinary command
failures remain agent-visible tool results; infrastructure failures are distinct.
Interrupted container creation is also treated as uncertain because the daemon
may finish creation after the client exits, even if immediate removal finds no
container.
Raw command output is available only through opt-in diagnostic capture.

Run `npm run test:sandbox` with the pinned image already provisioned to check
actual workspace containment, symlink rejection, network interfaces, resource
limits, output bounds, timeout, and cleanup. This explicit target fails on missing
configuration or runtime prerequisites. Ordinary deterministic tests skip these
three live tests and do not prove container isolation. The live suite requires a
Linux Docker engine, a Node.js image, and cgroup v2. On Windows, Docker Desktop's
Linux engine must be reachable; a running Desktop application alone is not enough.

> [!IMPORTANT]
> Keep results labeled by executor and sandbox backend. Do not pool container,
> external scaffold, and native Moss scores as measurements of one system.

## Use CI evaluation tiers

The checked-in workflows separate cost and confidence:

* `ci.yml` runs typecheck, deterministic and scripted-provider behavior tests,
  production build, and no-model representative corpus and grader health on
  Windows for pull requests and `main`
* `eval-provider-smoke.yml` checks pilot health on Ubuntu, then runs the three-case
  `local` pilot matrix with three repetitions per variant nightly or on demand
  and uploads compact reports; it requires no Docker image or containment setup
* `eval-release.yml` runs the full representative repeated matrix on a dedicated
  Windows Docker runner, requires compatible-baseline preflight and live
  containment before provider spend, enforces the non-inferiority gate, and
  uploads only candidate, progress, and diff reports

`eval-sandbox.yml` is a separate manually dispatched Windows containment check.
It requires a dedicated self-hosted runner labeled `moss-eval-sandbox` with a
working Linux engine. It does not execute on untrusted pull requests. Set the
repository variable `MOSS_EVAL_SANDBOX_IMAGE` to the approved image digest for
release and containment workflows. The release workflow explicitly selects
`full`, with no suite filter, and requires the
same Windows runner label. A missing runner or image is an unmet prerequisite, not a
passing containment result. Obtain a passing Windows live run before claiming
Windows containment; local scripted mocks cannot substitute for that result.

Nightly reports are partial and are not full release baselines. Their Ubuntu
runtime provenance also prevents comparison with Windows results.
CI resume arguments preserve local progress
within a run; workflows upload progress but do not automatically restore it on a
new workflow invocation. Retry opt-in is never enabled automatically in CI.

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
