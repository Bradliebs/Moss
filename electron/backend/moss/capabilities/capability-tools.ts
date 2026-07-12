import type { Tool } from "../tools/types";
import type { CapabilityCatalog } from "./capability-catalog";
import type { CapabilityInstaller } from "./capability-installer";

export function createCapabilityCatalogTools(catalog: CapabilityCatalog, installer: CapabilityInstaller): Tool[] {
  return [
    {
      name: "m_list_capabilities",
      description: "List curated, platform-compatible capability artifacts and their pinned versions, permissions, and tool IDs.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const entries = catalog.list();
        return { ok: true, content: entries.length === 0 ? "No curated capabilities are available." : JSON.stringify(entries, null, 2) };
      },
    },
    {
      name: "m_capability_status",
      description: "Inspect whether one exact curated capability version is installed, active, quarantined, or absent.",
      parameters: capabilityIdentitySchema(),
      async execute(args) {
        try {
          return { ok: true, content: JSON.stringify(await installer.status(required(args.id, "id"), required(args.version, "version")), null, 2) };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "m_install_capability",
      description: "Download or copy one exact curated capability version, verify its pinned SHA-256, and install it inertly in isolated app data. Installation never executes the artifact and requires approval.",
      parameters: capabilityIdentitySchema(),
      async execute(args) {
        try {
          return { ok: true, content: JSON.stringify(await installer.install(required(args.id, "id"), required(args.version, "version")), null, 2) };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "m_quarantine_capability",
      description: "Disable and quarantine an installed curated capability version with an audit reason. Requires approval.",
      parameters: {
        ...capabilityIdentitySchema(),
        properties: {
          ...capabilityIdentitySchema().properties as Record<string, unknown>,
          reason: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["id", "version", "reason"],
      },
      async execute(args) {
        try {
          return { ok: true, content: JSON.stringify(await installer.quarantine(required(args.id, "id"), required(args.version, "version"), required(args.reason, "reason")), null, 2) };
        } catch (error) {
          return failure(error);
        }
      },
    },
    {
      name: "m_remove_capability",
      description: "Remove an installed or quarantined curated capability version from isolated app data. Requires approval.",
      parameters: capabilityIdentitySchema(),
      async execute(args) {
        try {
          const id = required(args.id, "id");
          const version = required(args.version, "version");
          await installer.remove(id, version);
          return { ok: true, content: `Removed capability '${id}@${version}'.` };
        } catch (error) {
          return failure(error);
        }
      },
    },
  ];
}

function capabilityIdentitySchema(): Record<string, unknown> & { properties: Record<string, unknown> } {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, description: "Curated catalog capability ID." },
      version: { type: "string", minLength: 1, description: "Exact pinned semantic version." },
    },
    required: ["id", "version"],
  };
}

function required(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function failure(error: unknown): { ok: false; content: string } {
  return { ok: false, content: error instanceof Error ? error.message : String(error) };
}