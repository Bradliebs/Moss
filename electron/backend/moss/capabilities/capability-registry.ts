import { classifyTool } from "../permission";
import type { Tool } from "../tools/types";

export type CapabilitySource = "built-in" | "mcp" | "generated" | "browser" | "desktop";
export type CapabilityPlatform = NodeJS.Platform | "any";
export type CapabilityRisk = "readonly" | "low" | "mutating" | "destructive";
export type CapabilityHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface CapabilityHistory {
  successCount: number;
  failureCount: number;
}

export interface CapabilityMetadata {
  id: string;
  toolName: string;
  source: CapabilitySource;
  description: string;
  supportedPlatforms: CapabilityPlatform[];
  requiredCredentials: string[];
  risk: CapabilityRisk;
  health: CapabilityHealth;
  history: CapabilityHistory;
  estimatedCostUsd: number;
  tags: string[];
}

export interface Capability extends CapabilityMetadata {
  tool: Tool;
}

export interface CapabilityRegistration extends Partial<Omit<CapabilityMetadata, "toolName" | "source">> {
  tool: Tool;
  source: CapabilitySource;
}

export function normalizeCapability(registration: CapabilityRegistration): Capability {
  const toolName = registration.tool.name.trim();
  if (!toolName) throw new Error("A capability tool name is required");

  const id = (registration.id ?? `${registration.source}:${toolName}`).trim();
  if (!id) throw new Error("A capability id is required");

  const history = registration.history ?? { successCount: 0, failureCount: 0 };
  validateCount(history.successCount, "successCount");
  validateCount(history.failureCount, "failureCount");

  const estimatedCostUsd = registration.estimatedCostUsd ?? 0;
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    throw new Error("Capability estimated cost must be a non-negative number");
  }

  return {
    id,
    toolName,
    source: registration.source,
    description: (registration.description ?? registration.tool.description).trim(),
    supportedPlatforms: unique(registration.supportedPlatforms ?? ["any"]),
    requiredCredentials: unique(registration.requiredCredentials ?? []),
    risk: registration.risk ?? (classifyTool(toolName) === "allow" ? "readonly" : "mutating"),
    health: registration.health ?? "healthy",
    history: { ...history },
    estimatedCostUsd,
    tags: unique((registration.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase("en-US")).filter(Boolean)),
    tool: registration.tool,
  };
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, Capability>();

  constructor(registrations: CapabilityRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: CapabilityRegistration): Capability {
    const capability = normalizeCapability(registration);
    const key = canonicalId(capability.id);
    if (this.capabilities.has(key)) {
      throw new Error(`Capability id '${capability.id}' is already registered`);
    }
    this.capabilities.set(key, capability);
    return cloneCapability(capability);
  }

  unregister(id: string): boolean {
    return this.capabilities.delete(canonicalId(id));
  }

  get(id: string): Capability | undefined {
    const capability = this.capabilities.get(canonicalId(id));
    return capability ? cloneCapability(capability) : undefined;
  }

  list(): Capability[] {
    return [...this.capabilities.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneCapability);
  }
}

function canonicalId(id: string): string {
  return id.trim().toLocaleLowerCase("en-US");
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function validateCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Capability ${name} must be a non-negative integer`);
}

function cloneCapability(capability: Capability): Capability {
  return {
    ...capability,
    supportedPlatforms: [...capability.supportedPlatforms],
    requiredCredentials: [...capability.requiredCredentials],
    history: { ...capability.history },
    tags: [...capability.tags],
  };
}