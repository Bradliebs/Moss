export const CAPABILITY_PLATFORMS = ["any", "aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"] as const;
export const CAPABILITY_RUNTIMES = ["executable", "node", "python"] as const;

export type CatalogPlatform = (typeof CAPABILITY_PLATFORMS)[number];
export type CatalogRuntime = (typeof CAPABILITY_RUNTIMES)[number];

export interface CapabilityCatalogEntry {
  id: string;
  version: string;
  sourceUrl: string;
  sha256: string;
  platforms: CatalogPlatform[];
  runtime: CatalogRuntime;
  entry: {
    command: string;
    args: string[];
  };
  permissions: string[];
  toolIds: string[];
}

export interface CapabilityCatalogManifest {
  schemaVersion: 1;
  entries: CapabilityCatalogEntry[];
}

const ENTRY_KEYS = [
  "id",
  "version",
  "sourceUrl",
  "sha256",
  "platforms",
  "runtime",
  "entry",
  "permissions",
  "toolIds",
] as const;

export function validateCapabilityCatalog(value: unknown): CapabilityCatalogManifest {
  const manifest = requireRecord(value, "catalog manifest");
  requireExactKeys(manifest, ["schemaVersion", "entries"], "catalog manifest");
  if (manifest.schemaVersion !== 1) throw new Error("Catalog schemaVersion must be 1");
  if (!Array.isArray(manifest.entries)) throw new Error("Catalog entries must be an array");

  const entries = manifest.entries.map((entry, index) => validateEntry(entry, index));
  const versions = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.id}\u0000${entry.version}`;
    if (versions.has(key)) throw new Error(`Duplicate catalog entry '${entry.id}@${entry.version}'`);
    versions.add(key);
  }
  return { schemaVersion: 1, entries };
}

export class CapabilityCatalog {
  readonly entries: readonly CapabilityCatalogEntry[];

  constructor(manifest: unknown) {
    this.entries = validateCapabilityCatalog(manifest).entries;
  }

  get(id: string, version: string): CapabilityCatalogEntry | undefined {
    const entry = this.entries.find((candidate) => candidate.id === id && candidate.version === version);
    return entry ? structuredClone(entry) : undefined;
  }

  list(platform: NodeJS.Platform = process.platform): CapabilityCatalogEntry[] {
    return this.entries
      .filter((entry) => entry.platforms.includes("any") || entry.platforms.includes(platform as CatalogPlatform))
      .map((entry) => structuredClone(entry));
  }
}

function validateEntry(value: unknown, index: number): CapabilityCatalogEntry {
  const label = `catalog entry ${index}`;
  const entry = requireRecord(value, label);
  requireExactKeys(entry, ENTRY_KEYS, label);

  const id = requireString(entry.id, `${label} id`);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`${label} id must be a lowercase safe identifier`);
  }
  const version = requireString(entry.version, `${label} version`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`${label} version must be an exact pinned semantic version`);
  }

  const sourceUrl = requireString(entry.sourceUrl, `${label} sourceUrl`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new Error(`${label} sourceUrl must be a valid URL`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "file:") {
    throw new Error(`${label} sourceUrl must use https or file`);
  }

  const sha256 = requireString(entry.sha256, `${label} sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label} sha256 must be 64 lowercase hex characters`);

  const platforms = requireStringArray(entry.platforms, `${label} platforms`);
  if (platforms.length === 0 || platforms.some((platform) => !isIncluded(CAPABILITY_PLATFORMS, platform))) {
    throw new Error(`${label} platforms contain an unsupported platform`);
  }
  const runtime = requireString(entry.runtime, `${label} runtime`);
  if (!isIncluded(CAPABILITY_RUNTIMES, runtime)) throw new Error(`${label} runtime is unsupported`);

  const entryPoint = requireRecord(entry.entry, `${label} entry`);
  requireExactKeys(entryPoint, ["command", "args"], `${label} entry`);
  const command = requireString(entryPoint.command, `${label} entry command`);
  const args = requireStringArray(entryPoint.args, `${label} entry args`);
  const permissions = requireUniqueNonEmptyStrings(entry.permissions, `${label} permissions`);
  const toolIds = requireUniqueNonEmptyStrings(entry.toolIds, `${label} toolIds`);
  if (toolIds.length === 0) throw new Error(`${label} toolIds must not be empty`);

  return {
    id,
    version,
    sourceUrl,
    sha256,
    platforms: platforms as CatalogPlatform[],
    runtime: runtime as CatalogRuntime,
    entry: { command, args },
    permissions,
    toolIds,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() !== item)) {
    throw new Error(`${label} must be an array of trimmed strings`);
  }
  return [...value] as string[];
}

function requireUniqueNonEmptyStrings(value: unknown, label: string): string[] {
  const values = requireStringArray(value, label);
  if (values.some((item) => item.length === 0) || new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique non-empty strings`);
  }
  return values;
}

function isIncluded<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}