/** Zero-width and bidi control characters that are invisible on screen. */
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;

/** Unicode "tag" characters (U+E0000..U+E007F) can smuggle invisible ASCII text. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

/** True if the text contains characters a person can't see. */
export function hasInvisibleChars(text: string): boolean {
  INVISIBLE.lastIndex = 0;
  TAG_CHARS.lastIndex = 0;
  return INVISIBLE.test(text) || TAG_CHARS.test(text);
}

/** Decodes text hidden in Unicode tag characters ("ASCII smuggling"). Returns "" if there is none. */
export function decodeTagChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

/** Removes characters a person can't see, keeping everything else. */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "").replace(TAG_CHARS, "");
}

/** Canonical form used for scoring and fingerprints. */
export function normalize(text: string): string {
  return stripInvisible(text.normalize("NFKC")).replace(/\s+/g, " ").trim();
}

/** Lower-cased canonical form, so trivially different copies get the same fingerprint. */
export function fingerprintText(text: string): string {
  return normalize(text).toLowerCase();
}

/** SHA-256 hex of the fingerprint text. Works in browsers, extension workers and Node 20+. */
export async function fingerprint(text: string): Promise<string> {
  const data = new TextEncoder().encode(fingerprintText(text));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Shortens text for display without cutting a word in half where possible. */
export function clip(text: string, max: number): string {
  const t = normalize(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** Rough check that a string reads like language rather than code, ids or numbers. */
export function looksLikeProse(text: string): boolean {
  const t = normalize(text);
  if (t.length < 20) return false;
  const words = t.split(" ").filter((w) => /[a-z]{2,}/i.test(w));
  return words.length >= 5 && words.length / t.split(" ").length > 0.5;
}
