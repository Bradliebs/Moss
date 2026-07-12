import { describe, expect, it } from "vitest";

import { isNetworkUrlAllowed } from "./playwright-driver";

describe("Playwright browser network policy", () => {
  const allowedDomains = new Set(["example.com"]);

  it("allows configured domains and their subdomains", () => {
    expect(isNetworkUrlAllowed("https://example.com/path", allowedDomains)).toBe(true);
    expect(isNetworkUrlAllowed("https://api.example.com/path", allowedDomains)).toBe(true);
  });

  it("blocks redirects, lookalike domains, and non-network schemes", () => {
    expect(isNetworkUrlAllowed("https://evil.test/redirect", allowedDomains)).toBe(false);
    expect(isNetworkUrlAllowed("https://example.com.evil.test/", allowedDomains)).toBe(false);
    expect(isNetworkUrlAllowed("data:text/plain,no", allowedDomains)).toBe(false);
    expect(isNetworkUrlAllowed("file:///etc/passwd", allowedDomains)).toBe(false);
  });
});