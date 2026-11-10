/**
 * Small hashing helpers built on Web Crypto (available in Workers and Node >= 20).
 */

/** Hex-encoded SHA-256 of a string. */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic page id derived from the site and the URL, so re-indexing the same URL overwrites
 * existing rows and vectors instead of duplicating them, while two sites that list the same URL get
 * separate rows (and separate vector ids, which are derived from the page id).
 */
export async function pageIdFor(siteId: string, url: string): Promise<string> {
  return (await sha256Hex(`${siteId}\n${url}`)).slice(0, 24);
}

/** Constant-time string comparison for tokens. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  // crypto.subtle.timingSafeEqual is available in Workers; fall back to a manual loop elsewhere.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') return subtle.timingSafeEqual(bufA, bufB);
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  return diff === 0;
}
