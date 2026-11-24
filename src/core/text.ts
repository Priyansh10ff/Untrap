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

/** Rough check that a string reads like language rather than code, ids or numbers. Any script. */
export function looksLikeProse(text: string): boolean {
  const t = normalize(text);
  if (t.length < 20) return false;
  const all = t.split(" ");
  const words = all.filter((w) => /\p{L}{2,}|\p{L}\p{M}/u.test(w));
  return words.length >= 5 && words.length / all.length > 0.5;
}

// Common short words. Words shared between languages ("a", "de", "en", "no", "die") are left out.
const ENGLISH_WORDS = new Set("the to of and or is are be you your this that it in on for with from at as by not if all any we our can will please has have was were".split(" "));
const OTHER_WORDS = new Set(
  [
    "el los las del por con para una que es y su sus lo al ignora envía envia usted", // Spanish
    "le les des du et est une pour dans qui pas vous votre sur avec ce cette", // French
    "der das und ist nicht mit für sie ein eine zu den dem auf ich wir ihr", // German
    "os um uma não você seu sua com para do da dos das ao", // Portuguese
    "il gli che è per non della delle sono questo", // Italian
    "het een van niet je jouw voor met zijn", // Dutch
    "dan yang untuk tidak anda ini itu dengan", // Indonesian
  ].join(" ").split(" "),
);

/**
 * True unless the text is clearly in another language. The rule patterns and order checks are
 * English, so text in other languages is left to the AI (and the cloud double-checks it).
 * Text without many function words (menus, labels) counts as English.
 */
export function isMostlyEnglish(text: string): boolean {
  const words = normalize(text).toLowerCase().split(/[^\p{L}\p{M}']+/u).filter(Boolean);
  if (!words.length) return true;
  const latin = words.filter((w) => /^[a-z\u00c0-\u024f']+$/.test(w)).length;
  if (latin / words.length < 0.6) return false; // mostly another script
  const english = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  const other = words.filter((w) => OTHER_WORDS.has(w)).length;
  return !(other >= 2 && other > english);
}
