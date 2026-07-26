// electron/backend/moss/task/plan-store.ts
//
// Holds a short, ordered checklist for the current piece of work so the model
// has structure that survives across tool rounds. Conversation history is not a
// reliable place for this: each tool result is capped for the model, and older
// messages are dropped once compaction is on, so a plan written into chat text
// decays exactly when a long task needs it most.
//
// The store is deliberately small. It is a checklist, not a task engine: no
// dependencies, no nesting, no scheduling.

export type PlanStepStatus = "pending" | "active" | "done" | "blocked";

export interface PlanStep {
  id: number;
  text: string;
  status: PlanStepStatus;
  note?: string;
}

export const PLAN_STEP_STATUSES: PlanStepStatus[] = ["pending", "active", "done", "blocked"];

/** Caps keep the rendered plan cheap enough to resend every round. */
const MAX_STEPS = 20;
const MAX_TEXT_CHARS = 200;

const STATUS_MARK: Record<PlanStepStatus, string> = {
  pending: " ",
  active: ">",
  done: "x",
  blocked: "!",
};

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

export class PlanStore {
  private steps: PlanStep[] = [];

  /** Replaces the whole plan. Steps are renumbered from 1. */
  set(texts: string[]): PlanStep[] {
    this.steps = texts
      .map(normalize)
      .filter((text) => text.length > 0)
      .slice(0, MAX_STEPS)
      .map((text, index) => ({ id: index + 1, text, status: "pending" as PlanStepStatus }));
    return this.list();
  }

  /** Sets one step's status. Returns false when the id does not exist. */
  update(id: number, status: PlanStepStatus, note?: string): boolean {
    const step = this.steps.find((s) => s.id === id);
    if (!step) return false;
    step.status = status;
    const trimmed = note === undefined ? "" : normalize(note);
    if (trimmed) step.note = trimmed;
    else delete step.note;
    return true;
  }

  list(): PlanStep[] {
    return this.steps.map((s) => ({ ...s }));
  }

  isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** Compact text form, sized to be resent cheaply on every round. */
  render(): string {
    if (this.steps.length === 0) return "(no plan set)";
    const lines = this.steps.map(
      (s) => `${s.id}. [${STATUS_MARK[s.status]}] ${s.text}${s.note ? ` -- ${s.note}` : ""}`,
    );
    const done = this.steps.filter((s) => s.status === "done").length;
    return `${lines.join("\n")}\n(${done}/${this.steps.length} done)`;
  }
}
