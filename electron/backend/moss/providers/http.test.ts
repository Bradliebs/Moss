// electron/backend/moss/providers/http.test.ts
//
// Unit tests for the shared HTTP helpers: URL joining and the bounded,
// never-throwing error-body reader.

import { describe, expect, it } from "vitest";

import { joinUrl, safeText } from "./http";

describe("joinUrl", () => {
  it("joins a base and path without a trailing slash", () => {
    expect(joinUrl("https://api.example.com", "/v1/models")).toBe("https://api.example.com/v1/models");
  });

  it("strips a single trailing slash from the base", () => {
    expect(joinUrl("https://api.example.com/", "/v1/models")).toBe("https://api.example.com/v1/models");
  });

  it("strips multiple trailing slashes from the base", () => {
    expect(joinUrl("https://api.example.com///", "/v1/models")).toBe("https://api.example.com/v1/models");
  });
});

describe("safeText", () => {
  it("returns the response body text", async () => {
    expect(await safeText({ text: async () => "boom" })).toBe("boom");
  });

  it("caps the returned text at 500 characters", async () => {
    const big = "x".repeat(2000);
    expect((await safeText({ text: async () => big })).length).toBe(500);
  });

  it("returns an empty string when reading the body throws", async () => {
    expect(
      await safeText({
        text: async () => {
          throw new Error("stream consumed");
        },
      }),
    ).toBe("");
  });
});
