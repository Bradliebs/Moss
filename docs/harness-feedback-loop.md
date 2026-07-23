---
title: Harness Feedback Loop
description: Run grounded, provenance-aware Moss prompt evaluations and compare repeated results
ms.date: 2026-07-23
ms.topic: how-to
keywords:
  - evaluation harness
  - prompt evaluation
  - regression testing
  - provenance
estimated_reading_time: 5
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
