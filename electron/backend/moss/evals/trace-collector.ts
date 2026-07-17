import { createHash } from "node:crypto";

import type { HarnessExecutionTrace, HarnessTraceToolCall } from "../../../../common/evals";
import type { MossEvent } from "../../../../common/types";

/** Collects process metadata without retaining model text, tool arguments, or tool output. */
export class HarnessTraceCollector {
  private readonly calls = new Map<string, HarnessTraceToolCall>();
  private readonly callOrder: string[] = [];
  private readonly failedActions = new Map<string, string>();
  private inputTokens = 0;
  private outputTokens = 0;
  private terminalState: HarnessExecutionTrace["terminalState"];

  onEvent(event: MossEvent): void {
    if (event.type === "tool-call") {
      const call: HarnessTraceToolCall = {
        callId: event.callId,
        name: event.name,
        argumentHash: hashArguments(event.arguments),
        approvalRequested: false,
      };
      if (!this.calls.has(event.callId)) this.callOrder.push(event.callId);
      this.calls.set(event.callId, call);
      return;
    }

    if (event.type === "tool-approval-request") {
      const call = this.getOrCreateCall(event.callId, event.name);
      call.approvalRequested = true;
      call.risk = event.risk;
      return;
    }

    if (event.type === "tool-result") {
      const call = this.getOrCreateCall(event.callId, event.name);
      call.ok = event.ok;
      call.autoApproved = event.autoApproved;
      call.risk = event.risk ?? call.risk;
      call.durationMs = event.durationMs;
      const actionKey = traceActionKey(call);
      if (event.ok) {
        const failedCallId = this.failedActions.get(actionKey);
        if (failedCallId && failedCallId !== call.callId) call.recoveredFromCallId = failedCallId;
        this.failedActions.delete(actionKey);
      } else {
        this.failedActions.set(actionKey, call.callId);
      }
      return;
    }

    if (event.type === "token-usage") {
      this.inputTokens += event.usage.inputTokens ?? 0;
      this.outputTokens += event.usage.outputTokens ?? 0;
      return;
    }

    if (event.type === "turn-complete") this.terminalState = "completed";
    else if (event.type === "turn-aborted") this.terminalState = "aborted";
    else if (event.type === "turn-error") this.terminalState = "error";
  }

  snapshot(): HarnessExecutionTrace {
    return {
      toolCalls: this.callOrder.map((callId) => structuredClone(this.calls.get(callId)!)),
      usage: {
        ...(this.inputTokens > 0 ? { inputTokens: this.inputTokens } : {}),
        ...(this.outputTokens > 0 ? { outputTokens: this.outputTokens } : {}),
      },
      ...(this.terminalState ? { terminalState: this.terminalState } : {}),
    };
  }

  private getOrCreateCall(callId: string, name: string): HarnessTraceToolCall {
    const existing = this.calls.get(callId);
    if (existing) return existing;
    const call: HarnessTraceToolCall = { callId, name, approvalRequested: false };
    this.calls.set(callId, call);
    this.callOrder.push(callId);
    return call;
  }
}

function hashArguments(argumentsJson: string): string {
  return createHash("sha256").update(argumentsJson).digest("hex");
}

function traceActionKey(call: HarnessTraceToolCall): string {
  return `${call.name}:${call.argumentHash ?? "unknown"}`;
}