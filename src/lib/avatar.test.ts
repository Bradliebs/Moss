// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { avatarFileError, createAvatarDataUrl } from "./avatar";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("avatarFileError", () => {
  it("accepts supported raster image types", () => {
    expect(avatarFileError({ name: "moss.png", type: "image/png", size: 1024 })).toBeNull();
    expect(avatarFileError({ name: "moss.jpg", type: "image/jpeg", size: 1024 })).toBeNull();
    expect(avatarFileError({ name: "moss.webp", type: "image/webp", size: 1024 })).toBeNull();
  });

  it("rejects unsupported image types", () => {
    expect(avatarFileError({ name: "moss.svg", type: "image/svg+xml", size: 1024 })).toBe(
      "moss.svg: choose a PNG, JPG, or WebP image",
    );
  });

  it("rejects images larger than 10 MB", () => {
    expect(avatarFileError({ name: "moss.png", type: "image/png", size: 10 * 1024 * 1024 + 1 })).toBe(
      "moss.png: image is larger than 10 MB",
    );
  });
});

describe("createAvatarDataUrl", () => {
  it("center-crops the image to a 256px WebP avatar", async () => {
    const drawImage = vi.fn();
    const close = vi.fn();
    const image = { width: 400, height: 200, close } as unknown as ImageBitmap;
    vi.stubGlobal("createImageBitmap", vi.fn(() => Promise.resolve(image)));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/webp;base64,avatar");

    const result = await createAvatarDataUrl(new File(["image"], "moss.png", { type: "image/png" }));

    expect(result).toBe("data:image/webp;base64,avatar");
    expect(drawImage).toHaveBeenCalledWith(image, -128, 0, 512, 256);
    expect(close).toHaveBeenCalledOnce();
  });
});