import type { Capability, CapabilityPlatform, CapabilityRisk } from "./capability-registry";
import { CapabilityRegistry } from "./capability-registry";

export type CapabilityRequirementKind = "capability" | "tag";

export interface UnmetCapabilityRequirement {
  kind: CapabilityRequirementKind;
  requirement: string;
  reasons: string[];
}

export interface CapabilityRouteRequest {
  capabilityNames?: readonly string[];
  requiredTags?: readonly string[];
  platform?: NodeJS.Platform;
  availableCredentials?: Iterable<string>;
}

export interface CapabilityRouteResult {
  selected: Capability[];
  unmet: UnmetCapabilityRequirement[];
}

interface Requirement {
  kind: CapabilityRequirementKind;
  value: string;
}

interface RankedCapability {
  capability: Capability;
  matchRank: number;
}

const RISK_RANK: Record<CapabilityRisk, number> = {
  readonly: 0,
  low: 1,
  mutating: 2,
  destructive: 3,
};

export class CapabilityRouter {
  constructor(private readonly registry: CapabilityRegistry) {}

  route(request: CapabilityRouteRequest): CapabilityRouteResult {
    const platform = request.platform ?? process.platform;
    const credentials = new Set(request.availableCredentials ?? []);
    const capabilities = this.registry.list();
    const requirements = normalizeRequirements(request);
    const selected = new Map<string, Capability>();
    const unmet: UnmetCapabilityRequirement[] = [];

    for (const requirement of requirements) {
      const matching = capabilities
        .map((capability) => ({ capability, matchRank: matchRank(capability, requirement) }))
        .filter((candidate) => candidate.matchRank > 0);
      const eligible = matching.filter(({ capability }) => isEligible(capability, platform, credentials));

      if (eligible.length === 0) {
        unmet.push({
          kind: requirement.kind,
          requirement: requirement.value,
          reasons: unmetReasons(matching.map((candidate) => candidate.capability), platform, credentials),
        });
        continue;
      }

      eligible.sort(compareRankedCapabilities);
      const chosen = eligible[0].capability;
      selected.set(chosen.id.toLocaleLowerCase("en-US"), chosen);
    }

    return { selected: [...selected.values()], unmet };
  }
}

function normalizeRequirements(request: CapabilityRouteRequest): Requirement[] {
  const requirements: Requirement[] = [];
  for (const value of request.capabilityNames ?? []) {
    const normalized = normalize(value);
    if (normalized) requirements.push({ kind: "capability", value: normalized });
  }
  for (const value of request.requiredTags ?? []) {
    const normalized = normalize(value);
    if (normalized) requirements.push({ kind: "tag", value: normalized });
  }
  return [...new Map(requirements.map((item) => [`${item.kind}:${item.value}`, item])).values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value),
  );
}

function matchRank(capability: Capability, requirement: Requirement): number {
  const value = requirement.value;
  const nameMatch = normalize(capability.id) === value || normalize(capability.toolName) === value;
  const tagMatch = capability.tags.some((tag) => normalize(tag) === value);
  if (requirement.kind === "capability") return nameMatch ? 2 : tagMatch ? 1 : 0;
  return tagMatch ? 2 : nameMatch ? 1 : 0;
}

function isEligible(capability: Capability, platform: NodeJS.Platform, credentials: Set<string>): boolean {
  return capability.health === "healthy"
    && supportsPlatform(capability.supportedPlatforms, platform)
    && capability.requiredCredentials.every((credential) => credentials.has(credential));
}

function supportsPlatform(platforms: readonly CapabilityPlatform[], platform: NodeJS.Platform): boolean {
  return platforms.includes("any") || platforms.includes(platform);
}

function compareRankedCapabilities(left: RankedCapability, right: RankedCapability): number {
  return right.matchRank - left.matchRank
    || RISK_RANK[left.capability.risk] - RISK_RANK[right.capability.risk]
    || left.capability.estimatedCostUsd - right.capability.estimatedCostUsd
    || reliability(right.capability) - reliability(left.capability)
    || right.capability.history.successCount - left.capability.history.successCount
    || left.capability.id.localeCompare(right.capability.id);
}

function reliability(capability: Capability): number {
  const total = capability.history.successCount + capability.history.failureCount;
  return total === 0 ? -1 : capability.history.successCount / total;
}

function unmetReasons(
  matching: Capability[],
  platform: NodeJS.Platform,
  credentials: Set<string>,
): string[] {
  if (matching.length === 0) return ["No registered capability matches this requirement"];

  const reasons = new Set<string>();
  for (const capability of matching.sort((left, right) => left.id.localeCompare(right.id))) {
    if (capability.health !== "healthy") {
      reasons.add(`${capability.id} health is ${capability.health}`);
    }
    if (!supportsPlatform(capability.supportedPlatforms, platform)) {
      reasons.add(`${capability.id} does not support platform ${platform}`);
    }
    const missing = capability.requiredCredentials.filter((credential) => !credentials.has(credential));
    if (missing.length > 0) reasons.add(`${capability.id} requires credentials: ${missing.join(", ")}`);
  }
  return [...reasons];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}