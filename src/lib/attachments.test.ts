// src/lib/attachments.test.ts
//
// Unit tests for the pure attachment helpers (node environment).

import { describe, expect, it } from "vitest";

import { imageAttachmentError, isLikelyVisionModel, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, textAttachmentError } from "./attachments";

describe("imageAttachmentError", () => {
  it("accepts an in-bounds image", () => {
    expect(imageAttachmentError({ type: "image/png", size: 1024, name: "a.png" })).toBeNull();
  });

  it("rejects a non-image file", () => {
    expect(imageAttachmentError({ type: "application/pdf", size: 10, name: "doc.pdf" })).toBe(
      "doc.pdf: not an image",
    );
  });

  it("rejects an image over the size cap", () => {
    expect(
      imageAttachmentError({ type: "image/jpeg", size: MAX_IMAGE_BYTES + 1, name: "big.jpg" }),
    ).toBe("big.jpg: image is larger than 10 MB");
  });
});

describe("textAttachmentError", () => {
  it("accepts an in-bounds text file", () => {
    expect(textAttachmentError({ size: 1024, name: "a.txt" })).toBeNull();
  });

  it("rejects a text file over the size cap", () => {
    expect(textAttachmentError({ size: MAX_TEXT_BYTES + 1, name: "huge.md" })).toBe(
      "huge.md: text file is larger than 256 KB",
    );
  });
});

describe("isLikelyVisionModel", () => {
  it("recognizes common vision-capable models", () => {
    for (const m of ["gpt-4o", "claude-3-5-sonnet", "llama3.2-vision", "gemini-1.5-pro"]) {
      expect(isLikelyVisionModel(m)).toBe(true);
    }
  });

  it("does not flag text-only models", () => {
    for (const m of ["gpt-3.5-turbo", "llama3.1", "mistral-7b"]) {
      expect(isLikelyVisionModel(m)).toBe(false);
    }
  });
});
