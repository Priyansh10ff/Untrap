import type { Candidate, Finding, ScanResult } from "./types.ts";

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
  | { type: "engine-classify"; url: string; candidates: Candidate[]; settings: Settings }
  | { type: "engine-stats"; delta: StatsDelta }
  | { type: "get-stats" };

export interface StatsDelta {
  pages: number;
  threats: number;
  onDevice: number;
  inCloud: number;
  blocklist: number;
}

export const EMPTY_STATS: StatsDelta = { pages: 0, threats: 0, onDevice: 0, inCloud: 0, blocklist: 0 };
