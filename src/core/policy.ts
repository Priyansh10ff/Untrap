import type { Action, Candidate, Segment, Verdict } from "./types.ts";
import { scoreText } from "./rules.ts";
import { fingerprint, isMostlyEnglish, looksLikeProse, normalize } from "./text.ts";
import { looksLikeOrder } from "./ground.ts";

/**
 * The decisions that turn rule scores and model verdicts into actions. Tuned for one asymmetry:
 * removing hidden text costs people nothing (they can't see it), while removing visible text
 * changes the page they're reading. So hidden text is removed on suspicion, visible text only
 * when the model is sure.
 */
/**
 * The person's settings, limited to what this build can do: without cloud access (the public
 * build has no App Check token) the cloud and the shared blocklist stay off whatever the toggles say.
 */
export function limitToBuild<T extends { cloud: boolean; share: boolean }>(settings: T, cloudEnabled: boolean): T {
  return { ...settings, cloud: settings.cloud && cloudEnabled, share: settings.share && cloudEnabled };
}

export const POLICY = {
  /** Hidden text scoring at least this is removed right away, before any model runs. */
  preRemoveScore: 0.55,
  /** Hidden text scoring at least this is sent to the model. */
  hiddenCandidateScore: 0.25,
  /** Hidden prose this long is sent to the model even without rule signals. */
  hiddenProseChars: 60,
  /** Visible text needs a much stronger rule score before we ask the model. */
  visibleCandidateScore: 0.5,
  /** Most candidates checked by the model per page, highest score first. */
  maxCandidates: 20,
  /** An on-device "attack" below this confidence gets a second opinion from the cloud. */
  confidentAttack: 0.75,
  /** Rules this sure get a cloud second opinion if the device says benign. */
  rulesDisagree: 0.5,
};

export type Policy = typeof POLICY;

/** Picks the segments worth checking and scores them. */
export async function selectCandidates(segments: Segment[], policy: Policy = POLICY): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const s of segments) {
    const text = normalize(s.text);
    if (text.length < 12) continue;
    const { score, signals } = scoreText(text);
    const worth = s.hidden ? hiddenWorthChecking(s, text, score, policy) : score >= policy.visibleCandidateScore;
    if (!worth) continue;
    const hash = await fingerprint(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ ...s, text, score, signals, hash });
  }
  out.sort((a, b) => rank(b) - rank(a));
  return out.slice(0, policy.maxCandidates);
}

/**
 * The rules can't recognise every way of phrasing an order (other languages, polite or passive
 * wording), so they mustn't be the only gate. Hidden prose goes to the AI whatever the rules
 * say, with one exception: alt text and other attributes are prose on almost every page, so
 * they go only when something in them points at a machine reader or reads like an order.
 */
function hiddenWorthChecking(s: Segment, text: string, score: number, policy: Policy): boolean {
  if (score >= policy.hiddenCandidateScore) return true;
  if (!looksLikeProse(text)) return false;
  if (ATTRIBUTE_LIKE.has(s.technique)) return score > 0 || MACHINE_READER.test(text) || looksLikeOrder(text) || !isMostlyEnglish(text);
  return text.length >= policy.hiddenProseChars || (!isMostlyEnglish(text) && text.length >= policy.hiddenProseChars / 2);
}

const ATTRIBUTE_LIKE = new Set<Segment["technique"]>(["attribute", "aria-hidden"]);
/** Mentions of an automated reader, in any phrasing: "for AI", "LLMs", "bots", "crawlers". */
const MACHINE_READER = /\b(?:ai|a\.i\.|llms?|gpt|bots?|agents?|assistants?|models?|crawlers?|scrapers?|summari[sz]ers?|automated)\b/i;

const rank = (c: Candidate) => c.score + (c.hidden ? 0.2 : 0);

/** Should this candidate be removed before the model has looked at it? */
export function preRemove(c: Candidate, policy: Policy = POLICY): boolean {
  // Text smuggled in invisible Unicode tag characters has no legitimate use in a page.
  if (c.technique === "invisible-unicode") return true;
  return c.hidden && c.score >= policy.preRemoveScore;
}

/** Should an on-device verdict get a second opinion from the cloud? */
export function needsSecondOpinion(c: Candidate, v: Verdict, policy: Policy = POLICY): boolean {
  if (v.verdict === "suspicious") return true;
  if (v.verdict === "attack") {
    // People can see visible text, so removing it on the small model's word alone is too costly.
    if (!c.hidden && v.source === "on_device") return true;
    // Non-English text can't be checked against our order patterns: let the cloud confirm.
    if (v.source === "on_device" && !isMostlyEnglish(c.text)) return true;
    if (c.technique === "invisible-unicode") return false; // smuggled text is never legitimate
    // Weak evidence: nothing aims the text at an AI or asks for anything dangerous, yet the
    // small model says attack (a build comment, "You must enter a valid email"). The cloud decides.
    if (!c.signals.some((s) => RISKY_SIGNALS.has(s))) return true;
    return v.confidence < policy.confidentAttack;
  }
  // The device said benign. Quiet, polite attacks are where Gemini Nano slips, so double-check
  // when the rules disagree, or when hidden text speaks to an AI, reads like an order, or isn't
  // in English (Nano is set up for English, and our order checks are English too).
  if (v.source !== "on_device") return false;
  if (c.score >= policy.rulesDisagree) return true;
  if (!isMostlyEnglish(c.text)) return true;
  return c.hidden && (c.signals.includes("speaks to AI") || MACHINE_READER.test(c.text) || looksLikeOrder(c.text));
}

/** Signals that aim text at an AI or ask for something dangerous. */
const RISKY_SIGNALS = new Set(["speaks to AI", "overrides instructions", "fake system markup", "keep it from the user", "asks for secrets", "data leak link", "wants money moved", "runs commands", "sends the agent elsewhere", "bends the answer", "blocks the answer"]);

/**
 * The verdict we use when no model is available. Without AI we can't tell an article about
 * prompt injection from an actual one, so rules alone only act on hidden text with strong
 * signals. Visible text is left to the AI.
 */
export function rulesVerdict(c: Candidate, policy: Policy = POLICY): Verdict {
  if (c.technique === "invisible-unicode" || (c.hidden && c.score >= policy.preRemoveScore)) {
    return { verdict: "attack", category: "other", confidence: c.score, reason: "Hidden text that gives orders to AI assistants.", source: "rules" };
  }
  return { verdict: "benign", category: "none", confidence: 1 - c.score, reason: "Not clearly aimed at AI, and no AI was available to check.", source: "rules" };
}

/** What to do with a candidate once we have a verdict. */
export function actionFor(c: Candidate, v: Verdict): Action {
  if (v.verdict === "benign") return "kept";
  if (c.hidden) return "removed";
  // Visible text is only removed once the cloud (or the shared blocklist) has confirmed it.
  const decidedBy = v.source === "cache" ? v.from : v.source;
  if (decidedBy === "on_device" || decidedBy === "rules") return "flagged";
  return v.verdict === "attack" && v.confidence >= 0.6 ? "removed" : "flagged";
}
