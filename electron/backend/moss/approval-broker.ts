// electron/backend/moss/approval-broker.ts
//
// Bridges the async agent loop (main process) and the user's approve/deny click
// (renderer). The runner awaits `request(callId)`; the IPC handler calls
// `resolve(callId, approved)` when the user responds.

export class ApprovalBroker {
  private readonly pending = new Map<string, (approved: boolean) => void>();

  request(callId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending.set(callId, resolve);
    });
  }

  resolve(callId: string, approved: boolean): void {
    const fn = this.pending.get(callId);
    if (fn) {
      this.pending.delete(callId);
      fn(approved);
    }
  }

  /** Deny everything still waiting (used on abort). */
  denyAll(): void {
    for (const fn of this.pending.values()) fn(false);
    this.pending.clear();
  }
}
