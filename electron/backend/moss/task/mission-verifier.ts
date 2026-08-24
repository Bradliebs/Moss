import type { MissionEvidenceResult, MissionStepVerifier, MissionWorkerResult, MissionWorkOrder } from "./mission-controller";
import { detectWorkspaceVerificationChecks, VerificationRegistry } from "../verify/verification-registry";

export interface WorkspaceMissionVerifierOptions {
  workspaceRoot: string;
  registry?: VerificationRegistry;
}

export class WorkspaceMissionVerifier implements MissionStepVerifier {
  private readonly registry: VerificationRegistry;

  constructor(private readonly options: WorkspaceMissionVerifierOptions) {
    this.registry = options.registry ?? new VerificationRegistry();
  }

  async verify(
    order: MissionWorkOrder,
    _result: MissionWorkerResult,
    signal: AbortSignal,
  ): Promise<MissionEvidenceResult[]> {
    const evidence: MissionEvidenceResult[] = [];
    for (const criterion of order.acceptanceCriteria) {
      const checks = await detectWorkspaceVerificationChecks(this.options.workspaceRoot, criterion.id);
      if (checks.length === 0) {
        evidence.push({
          criterionId: criterion.id,
          kind: "external",
          passed: false,
          summary: `No deterministic workspace verification check is available for '${criterion.description}'`,
        });
        continue;
      }
      const results = await this.registry.runChecks(checks, this.options.workspaceRoot, signal);
      const failed = results.filter((item) => !item.ok);
      evidence.push({
        criterionId: criterion.id,
        kind: "command",
        passed: failed.length === 0,
        summary: failed.length === 0
          ? results.map((item) => item.summary).join("; ")
          : failed.map((item) => item.details ? `${item.summary}: ${item.details}` : item.summary).join("; "),
      });
    }
    return evidence;
  }
}