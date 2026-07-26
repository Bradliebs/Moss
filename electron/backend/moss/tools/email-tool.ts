// electron/backend/moss/tools/email-tool.ts
//
// Model-callable tool: send an email via the Resend HTTPS API. Resend handles
// TLS, retries, and deliverability server-side, so no SMTP library is needed.
// The key + verified "from" address come from settings (ctx.email); with no key
// the tool refuses. Like the other network tools it is approval-gated (not in
// AUTO_ALLOW), so the model-chosen recipient/subject are shown before any send.

import type { Tool } from "./types";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 20_000;
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function asRecipients(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean);
  return [];
}

export const sendEmailTool: Tool = {
  name: "send_email",
  description:
    "Send an email through the configured Resend account. Provide one or more recipient " +
    "addresses, a subject, and a plain-text body. Requires an email API key and from address in Settings.",
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address. Multiple addresses may be comma-separated.",
      },
      subject: { type: "string" },
      body: { type: "string", description: "Plain-text body." },
      html: { type: "string", description: "Optional HTML body; sent alongside the plain-text body." },
    },
    required: ["to", "subject", "body"],
  },
  async execute(args, ctx) {
    if (!ctx.email?.apiKey) {
      return { ok: false, content: "No email API key configured (set one in Settings)." };
    }
    if (!ctx.email.from) {
      return { ok: false, content: "No from address configured (set one in Settings)." };
    }
    if (!EMAIL_RE.test(ctx.email.from.replace(/^.*<([^>]+)>.*$/, "$1").trim())) {
      return { ok: false, content: "Invalid from address (use a verified sender, e.g. Name <you@domain.com>)." };
    }

    const to = asRecipients(args.to);
    const subject = typeof args.subject === "string" ? args.subject.trim() : "";
    const body = typeof args.body === "string" ? args.body : "";
    const html = typeof args.html === "string" && args.html.trim() ? args.html : undefined;
    if (to.length === 0) return { ok: false, content: "to is required" };
    if (to.length > MAX_RECIPIENTS) return { ok: false, content: `too many recipients (max ${MAX_RECIPIENTS})` };
    const bad = to.filter((a) => !EMAIL_RE.test(a));
    if (bad.length > 0) return { ok: false, content: `invalid recipient address: ${bad.join(", ")}` };
    if (!subject) return { ok: false, content: "subject is required" };
    if (!body.trim()) return { ok: false, content: "body is required" };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${ctx.email.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: ctx.email.from, to, subject, text: body, ...(html ? { html } : {}) }),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        let detail = raw.slice(0, 300);
        try {
          const j = JSON.parse(raw) as { message?: string; error?: string };
          detail = j.message || j.error || detail;
        } catch {
          /* keep raw text */
        }
        return { ok: false, content: `Resend error ${res.status}: ${detail}` };
      }
      let id = "";
      try {
        id = (JSON.parse(raw) as { id?: string }).id ?? "";
      } catch {
        /* no id in body */
      }
      return { ok: true, content: `Email sent to ${to.join(", ")}${id ? ` (id ${id})` : ""}` };
    } catch (e) {
      if (controller.signal.aborted) return { ok: false, content: "Send timed out or aborted" };
      return { ok: false, content: `Send failed: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
    }
  },
};
