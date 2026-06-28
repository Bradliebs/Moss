// electron/backend/moss/providers/http.ts
//
// Shared HTTP helpers for provider clients.

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/** Read a bounded slice of an error response body for diagnostics. Never throws. */
export async function safeText(res: { text: () => Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
