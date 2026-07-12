// Edge-safe hashing for device/tenant API keys. Must never import Node's
// `crypto` — Vercel Edge runtime has no Node built-ins (see architecture.md
// § Auth Model: "All three hashing paths use globalThis.crypto.subtle.digest").

const PEPPER = process.env.DEVICE_KEY_HASH_SECRET as string;

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashApiKey(plaintextKey: string): Promise<string> {
  const data = new TextEncoder().encode(`${plaintextKey}:${PEPPER}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

export function generateApiKey(prefix: 'device' | 'tenant'): { plaintextKey: string; keyPrefix: string } {
  const randomBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const plaintextKey = `${prefix}_${toHex(randomBytes.buffer)}`;
  const keyPrefix = plaintextKey.slice(0, 8);
  return { plaintextKey, keyPrefix };
}
