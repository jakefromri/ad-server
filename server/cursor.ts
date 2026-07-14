// Opaque keyset-pagination cursor: base64 of `${primary}|${id}`, for queries
// ordered by (primary desc, id desc) — a timestamp column plus its row id as
// tie-break, so the cursor is stable under concurrent inserts between pages.
// btoa/atob (Web-standard, Edge-safe), not Buffer — api/index.ts runs on
// Vercel Edge runtime, which has no Node.js globals (same constraint as
// hash.ts's crypto.subtle-over-Node-crypto rule). Shared by admin-ledger.ts
// and tenant-self.ts's play-log endpoint, both windowed fulfillments scans.

export function encodeCursor(primary: string, id: string): string {
  return btoa(`${primary}|${id}`);
}

export function decodeCursor(cursor: string): { primary: string; id: string } | null {
  try {
    const decoded = atob(cursor);
    const [primary, id] = decoded.split('|');
    if (!primary || !id) return null;
    return { primary, id };
  } catch {
    return null;
  }
}
