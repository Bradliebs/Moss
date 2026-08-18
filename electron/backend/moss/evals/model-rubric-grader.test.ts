import { describe, expect, it } from "vitest";

import type { ChatProvider, ChatRequest, ProviderStreamEvent } from "../providers/types";
import { createModelRubricGrader } from "./model-rubric-grader";
import { runRubricGrader } from "./rubric-grading";

class FixtureGraderProvider implements ChatProvider {
  readonly kind = "fixture";
  readonly requests: ChatRequest[] = [];
  private responseIndex = 0;

  constructor(private readonly responses: string[]) {}

  async *streamChat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    yield { type: "text-delta", text: this.responses[this.responseIndex++] };
  }

  async listModels(): Promise<string[]> {
    return ["grader-v1"];
  }
}

describe("model rubric grader", () => {
  it("makes one strict grading request per dimension with pinned prompt provenance", async () => {
    const provider = new FixtureGraderProvider([
      '{"label":"pass","reasonCode":"requirements-met"}',
      '{"label":"fail","reasonCode":"too-terse"}',
    ]);
    const grader = createModelRubricGrader({
      provider,
      model: "grader-v1",
      dimensions: [
        { id: "instruction-following", description: "Follows the request" },
        { id: "communication", description: "Communicates clearly" },
      ],
    });

    const assessment = await runRubricGrader(grader, {
      caseId: "case",
      objective: "Update the artifact",
      responseText: "Done",
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.every((request) => request.model === "grader-v1" && request.maxTokens === 200)).toBe(true);
    expect(provider.requests[0].messages[0].content).toContain("untrusted data");
    expect(JSON.parse(provider.requests[0].messages[1].content)).toMatchObject({
      dimension: { id: "instruction-following" },
      response: "Done",
    });
    expect(grader.provenance.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(assessment.judgments).toEqual([
      { dimensionId: "instruction-following", label: "pass", reasonCode: "requirements-met" },
      { dimensionId: "communication", label: "fail", reasonCode: "too-terse" },
    ]);
  });

  it("downgrades malformed output for only the affected dimension", async () => {
    const provider = new FixtureGraderProvider([
      "not-json",
      '{"label":"pass"}',
    ]);
    const grader = createModelRubricGrader({
      provider,
      model: "grader-v1",
      dimensions: [
        { id: "quality", description: "Quality" },
        { id: "communication", description: "Communication" },
      ],
    });

    const assessment = await runRubricGrader(grader, {
      caseId: "case",
      objective: "Do the work",
      responseText: "Done",
    });

    expect(assessment.judgments).toEqual([
      { dimensionId: "quality", label: "unknown", reasonCode: "rubric-grader-error" },
      { dimensionId: "communication", label: "pass" },
    ]);
  });
});