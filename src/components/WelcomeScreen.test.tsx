// @vitest-environment jsdom
//
// src/components/WelcomeScreen.test.tsx
//
// WelcomeScreen is presentational: it renders four starter prompts and reports
// the picked one through onPick. These tests lock that prop contract.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WelcomeScreen } from "./WelcomeScreen";

afterEach(cleanup);

describe("WelcomeScreen", () => {
  it("renders the four starter suggestions", () => {
    render(<WelcomeScreen onPick={() => {}} />);
    expect(screen.getByText("Summarize the files in my workspace.")).toBeDefined();
    expect(screen.getByText("Explain what this project does.")).toBeDefined();
    expect(screen.getByText("Find and fix a bug in the current folder.")).toBeDefined();
    expect(screen.getByText("Write a unit test for a function I point you to.")).toBeDefined();
  });

  it("reports the picked suggestion through onPick", () => {
    const onPick = vi.fn();
    render(<WelcomeScreen onPick={onPick} />);
    fireEvent.click(screen.getByText("Explain what this project does."));
    expect(onPick).toHaveBeenCalledWith("Explain what this project does.");
  });
});
