import { describe, expect, it } from "vitest";

import { RecoveryPolicy, type FailureClassification } from "./recovery-policy";

describe("RecoveryPolicy", () => {
  it.each<[unknown, FailureClassification]>([
    [{ message: "upstream unavailable", status: 503 }, "transient"],
    [Object.assign(new Error("socket failed"), { code: "ECONNRESET" }), "transient"],
    ["Invalid JSON arguments for write_file", "invalid-arguments"],
    ["Unknown tool image_analyze", "missing-capability"],
    [{ message: "Unauthorized", status: 401 }, "missing-credential"],
    [Object.assign(new Error("access failed"), { code: "EACCES" }), "permission-denied"],
    ["Unsupported platform: linux", "incompatible-environment"],
    ["Verification failed: npm test", "verification-failed"],
    ["Remote record was permanently deleted", "permanent-external"],
  ])("classifies %o as %s", (failure, expected) => {
    expect(new RecoveryPolicy().classify(failure)).toBe(expected);
  });

  it("applies configurable exponential backoff and stops at the retry limit", () => {
    const policy = new RecoveryPolicy({ maxTransientRetries: 2, baseBackoffMs: 100, maxBackoffMs: 150 });
    const failure = { message: "busy", status: 503 };

    expect(policy.decide(failure, { retryCount: 0 })).toMatchObject({
      action: "retry-with-backoff",
      retryAfterMs: 100,
    });
    expect(policy.decide(failure, { retryCount: 1 })).toMatchObject({
      action: "retry-with-backoff",
      retryAfterMs: 150,
    });
    expect(policy.decide(failure, { retryCount: 2 }).action).toBe("replan");
    expect(policy.decide(failure, { retryCount: 2, alternateCapabilityAvailable: true }).action).toBe(
      "alternate-capability",
    );
  });

  it("bounds argument repair and maps non-retryable failures to terminal actions", () => {
    const policy = new RecoveryPolicy({ maxArgumentRepairs: 1 });

    expect(policy.decide("Invalid arguments", { argumentRepairCount: 0 }).action).toBe("repair-arguments");
    expect(policy.decide("Invalid arguments", { argumentRepairCount: 1 }).action).toBe("replan");
    expect(policy.decide("Missing API key").action).toBe("block");
    expect(policy.decide("Permission denied").action).toBe("block");
    expect(policy.decide("Verification failed").action).toBe("replan");
    expect(policy.decide("Remote object is gone forever").action).toBe("fail");
  });

  it("forces replanning before retrying a repeated equivalent action", () => {
    const decision = new RecoveryPolicy({ maxTransientRetries: 5 }).decide(
      { message: "service unavailable", status: 503 },
      {
        retryCount: 0,
        actionSignature: "web_search:{query:moss}",
        previousActionSignatures: ["read_file:{path:a}", "web_search:{query:moss}"],
      },
    );

    expect(decision).toMatchObject({ classification: "transient", action: "replan" });
    expect(decision.reason).toContain("repeated-action loop");
  });
});