import type { Action, Candidate, Segment, Verdict } from "./types.ts";
import { scoreText } from "./rules.ts";
import { fingerprint, looksLikeProse, normalize } from "./text.ts";

/**
 * The decisions that turn rule scores and model verdicts into actions. Tuned for one asymmetry:
 * removing hidden text costs people nothing (they can't see it), while removing visible text
 * changes the page they're reading. So hidden text is removed on suspicion, visible text only
 * when the model is sure.
 */
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
  /** Rules this sure about hidden text get a cloud second opinion if the device says benign. */
  rulesDisagree: 0.8,
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
    const worth = s.hidden
      ? score >= policy.hiddenCandidateScore || (PROSE_CHECKED.has(s.technique) && text.length >= policy.hiddenProseChars && looksLikeProse(text))
      : score >= policy.visibleCandidateScore;
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
 * Hidden prose without any rule signals is still worth a model check when it was hidden on
 * purpose. Meta descriptions, alt text and noscript blocks are prose on almost every page, so
 * they need a rule signal first.
 */
const PROSE_CHECKED = new Set<Segment["technique"]>(["display-none", "visibility-hidden", "transparent", "tiny-font", "same-color", "offscreen", "clipped", "html-comment"]);

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
  if (v.verdict === "attack") return v.confidence < policy.confidentAttack;
  // The device said benign. Double-check only when the rules strongly disagree.
  return c.hidden && c.score >= policy.rulesDisagree;
}

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
  return v.verdict === "attack" && v.confidence >= 0.6 ? "removed" : "flagged";
}
