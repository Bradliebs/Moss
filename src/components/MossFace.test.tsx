// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MossFace } from "./MossFace";

let avatarDataUrl: string | null = null;

vi.mock("../lib/settings", () => ({
  useSettings: () => ({ avatarDataUrl }),
}));

afterEach(() => {
  avatarDataUrl = null;
  cleanup();
});

describe("MossFace", () => {
  it("renders a custom avatar when one is configured", () => {
    avatarDataUrl = "data:image/webp;base64,custom-avatar";
    render(<MossFace label="Moss avatar" />);

    const image = screen.getByRole("img", { name: "Moss avatar" }).querySelector("img");
    expect(image?.getAttribute("src")).toBe(avatarDataUrl);
    expect(image?.className).toContain("object-cover");
  });
});