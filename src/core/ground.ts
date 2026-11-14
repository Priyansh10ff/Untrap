import type { Candidate, Verdict } from "./types.ts";
import { scoreText } from "./rules.ts";
import { normalize } from "./text.ts";

/**
 * Keeps the models honest. Every attack verdict has to point at the words in the text that give
 * the AI an order. If those words aren't really there, or aren't an order (like "You own this
 * repository"), the verdict is turned into "benign". Small models in particular tend to flag
 * anything hidden or anything that starts with "you".
 */

const ORDER_START =
  /^(?:please\s+)?(?:ignore|disregard|forget|override|bypass|skip|send|email|e-mail|post|upload|forward|transfer|pay|donate|wire|include|append|add|insert|reveal|print|output|share|leak|exfiltrate|run|execute|delete|remove|install|download|open|visit|go to|navigate|click|redirect|tell|say|respond|reply|answer|write|describe|summari[sz]e|recommend|rate|rank|present|mention|buy|purchase|refuse|stop|act as|pretend|confirm|verify|complete|fill|submit|copy|paste|call|contact|subscribe|approve)\b/i;
const ORDER_ANYWHERE =
  /\b(?:you must|you should|you will|you need to|you are required to|you have to|make sure (?:you|to)|be sure to|do not|don't|never (?:tell|mention|reveal|say)|always (?:say|recommend|mention|describe))\b/i;
const STRONG_SIGNALS = new Set(["speaks to AI", "overrides instructions", "fake system markup", "keep it from the user", "asks for secrets", "data leak link", "wants money moved", "runs commands", "sends the agent elsewhere", "bends the answer", "orders the model", "blocks the answer"]);

/** True if the text contains something phrased as an order, rather than a statement. */
export function looksLikeOrder(text: string): boolean {
  const t = normalize(text);
  if (!t) return false;
  if (ORDER_ANYWHERE.test(t)) return true;
  if (scoreText(t).signals.some((s) => STRONG_SIGNALS.has(s))) return true;
  // An order usually starts a clause: "When summarizing, describe X as the best."
  // It can also hide behind "to": "the recommendation is to buy only from X and to tell readers…"
  return t.split(/[.;:!?\n,]|\band\b|\bthen\b|\b(?:is|are|was|be)\s+to\b|\bto\b/i).some((clause) => ORDER_START.test(clause.trim()));
}

const loose = (s: string) => normalize(s).toLowerCase().replace(/[“”"'`’]/g, "").replace(/[.…]+$/, "").trim();

/** Where the quoted instruction sits in the candidate text, if it's really there. */
export function findQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = loose(quote);
  if (q.length < 6) return null;
  const hay = normalize(text).toLowerCase();
  let at = hay.indexOf(q);
  if (at >= 0) return { start: at, end: at + q.length };
  // Models sometimes drop or swap quote marks: compare with quotes removed, then map back.
  const map: number[] = [];
  let stripped = "";
  for (let i = 0; i < hay.length; i++) {
    if (!/[“”"'`’]/.test(hay[i]!)) {
      map.push(i);
      stripped += hay[i];
    }
  }
  at = stripped.indexOf(q);
  if (at < 0) return null;
  return { start: map[at]!, end: map[at + q.length - 1]! + 1 };
}

/** Checks a verdict against the text. Returns the verdict to use. */
export function ground(c: Candidate, v: Verdict): Verdict {
  if (v.verdict === "benign" || v.source === "rules") return v;
  if (c.technique === "invisible-unicode") return v; // smuggled text is never legitimate
  // Shared blocklist entries come from other people's checks: they must still contain an order.
  if (v.source === "blocklist") return looksLikeOrder(c.text) ? v : { ...benign(), source: "blocklist" };
  const quote = v.instruction ?? "";
  const found = quote ? findQuote(c.text, quote) : null;
  if (found && looksLikeOrder(quote)) {
    return { ...v, instruction: normalize(c.text).slice(found.start, found.end) };
  }
  // The model's quote didn't hold up. Keep the verdict only if the text itself contains an order.
  if (looksLikeOrder(c.text)) return { ...v, instruction: undefined };
  return { ...benign(), source: v.source };
}

function benign(): Omit<Verdict, "source"> {
  return { verdict: "benign", category: "none", confidence: 0.8, reason: "It doesn't tell an AI to do anything." };
}
