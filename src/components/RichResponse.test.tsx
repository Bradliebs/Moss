// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RichResponse } from "./RichResponse";

describe("RichResponse", () => {
  it("renders nested GFM and copies fenced code", () => {
    const onCopy = vi.fn();
    render(
      <RichResponse
        content={"## Result\n\n- parent\n  - child\n\n```ts\nconst answer = 42;\n```"}
        onCopy={onCopy}
      />,
    );

    expect(screen.getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(screen.getByText("child").closest("ul")?.parentElement?.closest("ul")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(onCopy).toHaveBeenCalledWith("const answer = 42;");
  });

  it("routes safe links through the shell and strips unsafe links", () => {
    const openExternal = vi.fn();
    Object.assign(window, { moss: { shell: { openExternal } } });
    render(
      <RichResponse
        content={"[docs](https://example.com) [unsafe](javascript:alert(1))"}
        onCopy={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "docs" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
    expect(screen.getByText("unsafe").getAttribute("href")).toBeNull();
  });

  it("shows a stable streaming indicator", () => {
    render(<RichResponse content="Working" streaming onCopy={vi.fn()} />);
    expect(screen.getByLabelText("Moss is writing")).toBeTruthy();
  });

  it("copies an arbitrary selection within the response", () => {
    const onCopy = vi.fn();
    render(<RichResponse content="Copy only this phrase from the response." onCopy={onCopy} />);
    const textNode = screen.getByText(/Copy only this phrase/).firstChild!;
    const selection = {
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "only this phrase",
      getRangeAt: () => ({
        getBoundingClientRect: () => ({ left: 100, top: 80, width: 120 }),
      }),
      removeAllRanges: vi.fn(),
    };
    vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);

    fireEvent(document, new Event("selectionchange"));
    fireEvent.click(screen.getByRole("button", { name: "Copy selection" }));

    expect(onCopy).toHaveBeenCalledWith("only this phrase");
    expect(selection.removeAllRanges).toHaveBeenCalled();
  });
});