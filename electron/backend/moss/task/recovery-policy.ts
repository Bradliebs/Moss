export type FailureClassification =
  | "transient"
  | "invalid-arguments"
  | "missing-capability"
  | "missing-credential"
  | "permission-denied"
  | "incompatible-environment"
  | "verification-failed"
  | "permanent-external";

export type RecoveryAction =
  | "retry-with-backoff"
  | "repair-arguments"
  | "alternate-capability"
  | "replan"
  | "block"
  | "fail";

export interface FailureDetails {
  message: string;
  code?: string;
  status?: number;
}

export interface RecoveryContext {
  retryCount?: number;
  argumentRepairCount?: number;
  actionSignature?: string;
  previousActionSignatures?: readonly string[];
  alternateCapabilityAvailable?: boolean;
}

export interface RecoveryDecision {
  classification: FailureClassification;
  action: RecoveryAction;
  reason: string;
  retryAfterMs?: number;
}

export interface RecoveryPolicyOptions {
  maxTransientRetries?: number;
  maxArgumentRepairs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETDOWN", "ENETUNREACH", "ETIMEDOUT"]);
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429]);

export class RecoveryPolicy {
  private readonly maxTransientRetries: number;
  private readonly maxArgumentRepairs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(options: RecoveryPolicyOptions = {}) {
    this.maxTransientRetries = nonNegativeInteger(options.maxTransientRetries ?? 2, "maxTransientRetries");
    this.maxArgumentRepairs = nonNegativeInteger(options.maxArgumentRepairs ?? 1, "maxArgumentRepairs");
    this.baseBackoffMs = nonNegativeNumber(options.baseBackoffMs ?? 250, "baseBackoffMs");
    this.maxBackoffMs = nonNegativeNumber(options.maxBackoffMs ?? 5_000, "maxBackoffMs");
    if (this.maxBackoffMs < this.baseBackoffMs) {
      throw new Error("maxBackoffMs must be greater than or equal to baseBackoffMs");
    }
  }

  classify(error: unknown): FailureClassification {
    const failure = failureDetails(error);
    const message = failure.message.toLocaleLowerCase("en-US");
    const code = failure.code?.toLocaleUpperCase("en-US");

    if (failure.status === 401 || /\b(?:missing|invalid|expired) (?:api key|token|credential)s?\b|\bunauthorized\b/.test(message)) {
      return "missing-credential";
    }
    if (failure.status === 403 || code === "EACCES" || code === "EPERM" || /\bpermission denied\b|\bapproval (?:was )?denied\b|\bforbidden\b/.test(message)) {
      return "permission-denied";
    }
    if (/\bverification failed\b|\bacceptance criteri(?:on|a).*(?:failed|not met)\b/.test(message)) {
      return "verification-failed";
    }
    if (/\binvalid (?:json )?arguments?\b|\bargument validation\b|\bschema validation\b|\bmalformed (?:input|arguments?)\b/.test(message)) {
      return "invalid-arguments";
    }
    if (code === "ENOENT" || /\b(?:unknown|missing|unavailable) (?:tool|capability)\b|\btool .* not (?:found|registered)\b|\bcommand not found\b/.test(message)) {
      return "missing-capability";
    }
    if (/\bunsupported platform\b|\bincompatible (?:environment|platform|architecture)\b|\bnot supported on\b/.test(message)) {
      return "incompatible-environment";
    }
    if ((failure.status !== undefined && (failure.status >= 500 || TRANSIENT_STATUSES.has(failure.status)))
      || (code !== undefined && TRANSIENT_CODES.has(code))
      || /\b(?:timed? out|timeout|rate limit|temporarily unavailable|service unavailable|connection reset)\b/.test(message)) {
      return "transient";
    }
    return "permanent-external";
  }

  decide(error: unknown, context: RecoveryContext = {}): RecoveryDecision {
    const classification = this.classify(error);
    const signature = context.actionSignature?.trim();
    if (signature && context.previousActionSignatures?.includes(signature)) {
      return {
        classification,
        action: "replan",
        reason: `Action '${signature}' has already been attempted; replan to prevent a repeated-action loop`,
      };
    }

    if (classification === "transient") {
      const retryCount = context.retryCount ?? 0;
      if (retryCount < this.maxTransientRetries) {
        return {
          classification,
          action: "retry-with-backoff",
          reason: `Transient failure is eligible for retry ${retryCount + 1} of ${this.maxTransientRetries}`,
          retryAfterMs: Math.min(this.maxBackoffMs, this.baseBackoffMs * (2 ** retryCount)),
        };
      }
      return alternateOrReplan(classification, context, "Transient retry limit reached");
    }

    if (classification === "invalid-arguments") {
      const repairCount = context.argumentRepairCount ?? 0;
      if (repairCount < this.maxArgumentRepairs) {
        return {
          classification,
          action: "repair-arguments",
          reason: `Invalid arguments are eligible for repair ${repairCount + 1} of ${this.maxArgumentRepairs}`,
        };
      }
      return alternateOrReplan(classification, context, "Argument repair limit reached");
    }

    if (classification === "missing-capability") {
      return alternateOrReplan(classification, context, "The requested capability is unavailable");
    }
    if (classification === "verification-failed") {
      return { classification, action: "replan", reason: "Verification failed; the execution plan must change" };
    }
    if (classification === "missing-credential" || classification === "permission-denied" || classification === "incompatible-environment") {
      return { classification, action: "block", reason: "Recovery requires an external prerequisite or user decision" };
    }
    return { classification, action: "fail", reason: "The external failure is permanent and has no bounded recovery" };
  }
}

function alternateOrReplan(
  classification: FailureClassification,
  context: RecoveryContext,
  reason: string,
): RecoveryDecision {
  return {
    classification,
    action: context.alternateCapabilityAvailable ? "alternate-capability" : "replan",
    reason,
  };
}

function failureDetails(error: unknown): FailureDetails {
  if (typeof error === "string") return { message: error };
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    return {
      message: typeof value.message === "string" ? value.message : String(error),
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.status === "number" ? { status: value.status } : {}),
    };
  }
  return { message: String(error) };
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}