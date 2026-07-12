// electron/backend/moss/governed/confidence.test.ts

import { describe, expect, it } from "vitest";

import { classifyConfidenceMode, describeConfidence } from "./confidence";

describe("classifyConfidenceMode", () => {
  it("is 'settled' when no tools ran", () => {
    expect(classifyConfidenceMode({ toolRan: false, toolFailed: false, usedExternal: false })).toBe("settled");
  });

  it("is 'reasoned' when tools ran without failure or external content", () => {
    expect(classifyConfidenceMode({ toolRan: true, toolFailed: false, usedExternal: false })).toBe("reasoned");
  });

  it("is 'web-fresh' when external content was used", () => {
    expect(classifyConfidenceMode({ toolRan: true, toolFailed: false, usedExternal: true })).toBe("web-fresh");
  });

  it("is 'needs-review' when any tool failed, overriding other signals", () => {
    expect(classifyConfidenceMode({ toolRan: true, toolFailed: true, usedExternal: true })).toBe("needs-review");
  });
});

describe("describeConfidence", () => {
  it("returns a non-empty note for every mode", () => {
    for (const mode of ["settled", "reasoned", "web-fresh", "needs-review"] as const) {
      expect(describeConfidence(mode).length).toBeGreaterThan(0);
    }
  });
});
