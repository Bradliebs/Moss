// electron/backend/moss/tools/email-tool.test.ts
//
// Unit tests for the send_email tool. The Resend network call is stubbed, so
// these exercise the tool's own logic: config guards, recipient parsing and
// validation, required-field checks, the POST shape, and error handling.

import { afterEach, describe, expect, it, vi } from "vitest";

import { sendEmailTool } from "./email-tool";
import type { ToolContext } from "./types";

const EMAIL = { apiKey: "re_test", from: "Moss <noreply@moss.local>" };

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { workspaceRoot: "/work", signal: new AbortController().signal, email: EMAIL, ...overrides };
}

const args = { to: "a@b.com", subject: "Hi", body: "Hello" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("send_email", () => {
  it("refuses without an API key", async () => {
    const res = await sendEmailTool.execute(args, ctx({ email: undefined }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No email API key");
  });

  it("refuses without a from address", async () => {
    const res = await sendEmailTool.execute(args, ctx({ email: { apiKey: "re_test", from: "" } }));
    expect(res.ok).toBe(false);
    expect(res.content).toContain("No from address");
  });

  it("validates recipients, subject, and body", async () => {
    expect((await sendEmailTool.execute({ to: "", subject: "s", body: "b" }, ctx())).content).toBe("to is required");
    expect((await sendEmailTool.execute({ to: "nope", subject: "s", body: "b" }, ctx())).content).toContain("invalid recipient");
    expect((await sendEmailTool.execute({ to: "a@b.com", subject: " ", body: "b" }, ctx())).content).toBe("subject is required");
    expect((await sendEmailTool.execute({ to: "a@b.com", subject: "s", body: " " }, ctx())).content).toBe("body is required");
  });

  it("posts to Resend and reports the id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await sendEmailTool.execute({ to: "a@b.com, c@d.com", subject: "Hi", body: "Hello" }, ctx());
    expect(res).toEqual({ ok: true, content: "Email sent to a@b.com, c@d.com (id abc)" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ from: EMAIL.from, to: ["a@b.com", "c@d.com"], subject: "Hi", text: "Hello" });
  });

  it("surfaces a Resend error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "bad key" }), { status: 401 })));
    const res = await sendEmailTool.execute(args, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("Resend error 401: bad key");
  });
});
