// electron/backend/moss/tools/plan-tool.ts
//
// One tool with an action discriminator rather than three separate tools, so
// the schema is sent once per model call instead of three times.
//
// The plan lives in turn state (PlanStore), not in chat text, so it survives
// the per-result truncation and history compaction that the model-facing
// conversation is subject to.

import type { PlanStepStatus } from "../task/plan-store";
import { PLAN_STEP_STATUSES } from "../task/plan-store";
import type { Tool, ToolContext, ToolResult } from "./types";

function isStatus(value: unknown): value is PlanStepStatus {
  return typeof value === "string" && (PLAN_STEP_STATUSES as string[]).includes(value);
}

export const planTool: Tool = {
  name: "plan",
  description:
    "Track a checklist for multi-step work. Set the steps once, then mark each one as you go.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["set", "update", "show"] },
      steps: {
        type: "array",
        items: { type: "string" },
        description: "Ordered step list, required for set",
      },
      id: { type: "number", description: "Step number, required for update" },
      status: { type: "string", enum: PLAN_STEP_STATUSES as string[] },
      note: { type: "string", description: "Short reason, useful when blocked" },
    },
    required: ["action"],
  },
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const plan = ctx.plan;
    if (!plan) return Promise.resolve({ ok: false, content: "Planning is not available in this turn" });

    const action = String(args.action ?? "").trim();

    if (action === "show") {
      return Promise.resolve({ ok: true, content: plan.render() });
    }

    if (action === "set") {
      if (!Array.isArray(args.steps)) {
        return Promise.resolve({ ok: false, content: "steps must be an array of strings" });
      }
      const texts = args.steps.map((s) => String(s ?? ""));
      const set = plan.set(texts);
      if (set.length === 0) {
        return Promise.resolve({ ok: false, content: "steps contained no usable text" });
      }
      return Promise.resolve({ ok: true, content: plan.render() });
    }

    if (action === "update") {
      const id = Number(args.id);
      if (!Number.isInteger(id)) {
        return Promise.resolve({ ok: false, content: "id must be a step number" });
      }
      if (!isStatus(args.status)) {
        return Promise.resolve({
          ok: false,
          content: `status must be one of: ${PLAN_STEP_STATUSES.join(", ")}`,
        });
      }
      const note = args.note === undefined ? undefined : String(args.note);
      if (!plan.update(id, args.status, note)) {
        return Promise.resolve({ ok: false, content: `No step with id ${id}` });
      }
      return Promise.resolve({ ok: true, content: plan.render() });
    }

    return Promise.resolve({ ok: false, content: "action must be one of: set, update, show" });
  },
};
