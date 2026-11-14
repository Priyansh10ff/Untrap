import type { Candidate, Finding, ScanResult, Verdict } from "./types.ts";

/** Reply to a "scan": verdicts we already knew, and the fingerprints still being checked. */
export interface ScanReply {
  verdicts: Record<string, Verdict>;
  queued: string[];
}

/** Messages between the page, the background worker, the AI engine and the popup. */

export interface Settings {
  enabled: boolean;
  /** Ask cloud Gemini for a second opinion when the on-device model is unsure. */
  cloud: boolean;
  /** Check and contribute to the shared blocklist. */
  share: boolean;
  /** Sites where Untrap is paused. */
  paused: string[];
}

export const DEFAULT_SETTINGS: Settings = { enabled: true, cloud: true, share: true, paused: [] };

export interface TabState {
  url: string;
  host: string;
  scanned: boolean;
  paused: boolean;
  findings: Finding[];
  mode: ScanResult["mode"];
  /** Candidates still waiting on the model. */
  pending: number;
  updatedAt: number;
}

export type EngineStatus = {
  onDevice: "available" | "downloadable" | "downloading" | "unavailable" | "unsupported";
  cloud: boolean;
  firebase: boolean;
  error?: string;
};

export type Msg =
  | { type: "scan"; url: string; candidates: Candidate[] }
  | { type: "report"; state: Omit<TabState, "updatedAt"> }
  | { type: "get-tab-state"; tabId: number }
  | { type: "xray"; on: boolean }
  | { type: "xray-closed" }
  | { type: "rescan" }
  | { type: "restore" }
  | { type: "get-status" }
  | { type: "engine-status" }
  | { type: "engine-classify"; tabId: number; url: string; candidates: Candidate[]; settings: Settings }
  /** Engine -> background, one per candidate as soon as it's decided. */
  | { type: "engine-verdict"; tabId: number; url: string; hash: string; verdict: Verdict }
  /** Background -> page. */
  | { type: "verdict"; hash: string; verdict: Verdict }
  | { type: "engine-stats"; delta: StatsDelta }
  /** Runs one known attack through the AI and reports where it ran and how long it took. */
  | { type: "self-test" }
  | { type: "engine-self-test" }
  | { type: "get-stats" };

export interface SelfTest {
  ok: boolean;
  source?: string;
  verdict?: string;
  category?: string;
  ms?: number;
  cloudOk?: boolean;
  cloudMs?: number;
  error?: string;
  cloudError?: string;
  appCheck?: string;
  fastCloud?: string;
}

export interface StatsDelta {
  pages: number;
  threats: number;
  onDevice: number;
  inCloud: number;
  blocklist: number;
}

export const EMPTY_STATS: StatsDelta = { pages: 0, threats: 0, onDevice: 0, inCloud: 0, blocklist: 0 };
