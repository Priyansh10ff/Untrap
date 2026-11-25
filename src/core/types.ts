/** Where on the page a piece of text was found, and how it was hidden from people. */
export type Technique =
  | "html-comment"
  | "display-none"
  | "visibility-hidden"
  | "transparent"
  | "tiny-font"
  | "same-color"
  | "offscreen"
  | "clipped"
  | "aria-hidden"
  | "attribute"
  | "meta"
  | "noscript"
  | "invisible-unicode"
  | "visible";

/** A piece of page text that an AI would read. */
export interface Segment {
  id: string;
  text: string;
  technique: Technique;
  /** True when a person looking at the page can't see this text. */
  hidden: boolean;
  /** A short human-readable location, for example `<div.footer>` or `meta[name=description]`. */
  where: string;
  /** For attribute segments: which attribute. */
  attr?: string;
}

/** What an attack is trying to make the AI do. */
export const CATEGORIES = [
  "data_exfiltration",
  "payment",
  "command_execution",
  "navigation_hijack",
  "instruction_override",
  "answer_manipulation",
  "refusal",
  "other",
  "none",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  data_exfiltration: "Tries to steal data",
  payment: "Tries to send money",
  command_execution: "Tries to run commands",
  navigation_hijack: "Tries to send the agent elsewhere",
  instruction_override: "Tries to override instructions",
  answer_manipulation: "Tries to bias the answer",
  refusal: "Tries to make the AI refuse",
  other: "Targets AI assistants",
  none: "Harmless",
};

/** A segment worth a closer look, with the rule-based score. */
export interface Candidate extends Segment {
  /** 0..1, how much this looks like an instruction aimed at an AI. */
  score: number;
  signals: string[];
  /** Fingerprint of the normalized text, used for the cache and the shared blocklist. */
  hash: string;
}

export type VerdictLabel = "attack" | "suspicious" | "benign";
export type VerdictSource = "rules" | "on_device" | "in_cloud" | "blocklist" | "cache";

export interface Verdict {
  verdict: VerdictLabel;
  category: Category;
  /** 0..1 */
  confidence: number;
  /** One short sentence for people. */
  reason: string;
  source: VerdictSource;
  /** The exact words in the text that give the AI an order (checked to be really there). */
  instruction?: string;
  /** For cached verdicts: which layer decided originally. */
  from?: VerdictSource;
  /**
   * Set when the AI should have checked this but couldn't (quota used up, model stuck), so only
   * the rules decided. Such verdicts aren't saved, so the text is checked again next visit.
   */
  unavailable?: string;
}

export type Action = "removed" | "flagged" | "kept";

export interface Finding {
  candidate: Candidate;
  verdict: Verdict;
  action: Action;
}

/** What the page sends to the engine. */
export interface ScanRequest {
  url: string;
  candidates: Candidate[];
}

/** What the engine sends back for each candidate. */
export interface ScanResult {
  verdicts: Record<string, Verdict>;
  /** Where the AI ran on this page: on the device, in the cloud, both, or not at all. */
  mode: "on_device" | "in_cloud" | "mixed" | "none";
}
