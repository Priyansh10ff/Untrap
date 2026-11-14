import { DEFAULT_SETTINGS, EMPTY_STATS, type EngineStatus, type Msg, type ScanReply, type Settings, type StatsDelta, type TabState } from "../core/messages.ts";
import { rulesVerdict } from "../core/policy.ts";
import type { Candidate, Verdict } from "../core/types.ts";

/**
 * The background worker routes messages: pages ask for verdicts, the popup asks for tab state.
 * The AI itself runs in an offscreen document (see offscreen.ts), which keeps the model session
 * and Firebase alive between pages.
 */

// Bump when the prompt or policy changes, so old verdicts aren't reused.
const CACHE_KEY = "verdicts-v2";
const CACHE_MAX = 3000;
const CACHE_TTL = 7 * 24 * 3600_000;
const ENGINE_TIMEOUT = 20_000; // status and stats calls only; verdicts stream in separately
const STATS_ALARM = "flush-stats";

type CacheEntry = { v: Verdict; t: number };

async function settings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
}

// ---------- offscreen engine ----------

let creating: Promise<void> | null = null;

async function ensureEngine() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.DOM_PARSER],
      justification: "Runs the prompt-injection classifier (Gemini Nano through Firebase AI Logic) on text found in pages.",
    })
    .catch((err: Error) => {
      if (!/single offscreen/i.test(err.message)) throw err;
    })
    .finally(() => (creating = null));
  await creating;
}

async function askEngine<T>(msg: Msg): Promise<T> {
  await ensureEngine();
  return (await Promise.race([
    chrome.runtime.sendMessage(msg),
    new Promise((_, reject) => setTimeout(() => reject(new Error("engine timed out")), ENGINE_TIMEOUT)),
  ])) as T;
}

// ---------- verdict cache ----------

async function readCache(): Promise<Record<string, CacheEntry>> {
  return ((await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as Record<string, CacheEntry> | undefined) ?? {};
}

async function writeCache(updates: Record<string, Verdict>) {
  const cache = await readCache();
  const now = Date.now();
  for (const [hash, v] of Object.entries(updates)) if (v.source !== "rules") cache[hash] = { v, t: now };
  const entries = Object.entries(cache).filter(([, e]) => now - e.t < CACHE_TTL);
  entries.sort((a, b) => b[1].t - a[1].t);
  await chrome.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries.slice(0, CACHE_MAX)) });
}

// ---------- scanning ----------

/**
 * Answers right away with what we already know. Everything else goes to the engine, which
 * sends each verdict back as soon as it's ready (see "engine-verdict"), so the page updates
 * one trap at a time instead of waiting for the slowest one.
 */
async function scan(tabId: number, url: string, candidates: Candidate[]): Promise<ScanReply> {
  const s = await settings();
  const cache = await readCache();
  const verdicts: Record<string, Verdict> = {};
  const misses: Candidate[] = [];
  for (const c of candidates) {
    const hit = cache[c.hash];
    if (hit && Date.now() - hit.t < CACHE_TTL) verdicts[c.hash] = { ...hit.v, source: "cache" };
    else misses.push(c);
  }
  await countStats(Object.values(verdicts));
  if (misses.length) {
    try {
      await ensureEngine();
      await chrome.runtime.sendMessage({ type: "engine-classify", tabId, url, candidates: misses, settings: s } satisfies Msg);
    } catch (err) {
      console.warn("Untrap engine unavailable, using rules only:", err);
      for (const c of misses) verdicts[c.hash] = rulesVerdict(c);
      return { verdicts, queued: [] };
    }
  }
  return { verdicts, queued: misses.map((c) => c.hash) };
}

async function onVerdict(tabId: number, hash: string, verdict: Verdict) {
  await writeCache({ [hash]: verdict });
  await countStats([verdict]);
  await chrome.tabs.sendMessage(tabId, { type: "verdict", hash, verdict } satisfies Msg).catch(() => {});
}

// ---------- stats ----------

async function countStats(verdicts: Verdict[]) {
  const stored = (await chrome.storage.local.get(["stats", "pendingStats"])) as { stats?: StatsDelta; pendingStats?: StatsDelta };
  const delta: StatsDelta = {
    pages: 0,
    threats: verdicts.filter((v) => v.verdict !== "benign").length,
    onDevice: verdicts.filter((v) => v.source === "on_device").length,
    inCloud: verdicts.filter((v) => v.source === "in_cloud").length,
    blocklist: verdicts.filter((v) => v.source === "blocklist").length,
  };
  await chrome.storage.local.set({ stats: add(stored.stats, delta), pendingStats: add(stored.pendingStats, delta) });
}

async function countPage() {
  const stored = (await chrome.storage.local.get(["stats", "pendingStats"])) as { stats?: StatsDelta; pendingStats?: StatsDelta };
  const delta = { ...EMPTY_STATS, pages: 1 };
  await chrome.storage.local.set({ stats: add(stored.stats, delta), pendingStats: add(stored.pendingStats, delta) });
}

function add(a: StatsDelta | undefined, b: StatsDelta): StatsDelta {
  const base = a ?? EMPTY_STATS;
  return { pages: base.pages + b.pages, threats: base.threats + b.threats, onDevice: base.onDevice + b.onDevice, inCloud: base.inCloud + b.inCloud, blocklist: base.blocklist + b.blocklist };
}

async function flushStats() {
  const s = await settings();
  const { pendingStats } = (await chrome.storage.local.get("pendingStats")) as { pendingStats?: StatsDelta };
  if (!s.share || !pendingStats || Object.values(pendingStats).every((n) => n === 0)) return;
  try {
    const result = await askEngine<{ ok: boolean }>({ type: "engine-stats", delta: pendingStats });
    if (result.ok) await chrome.storage.local.set({ pendingStats: EMPTY_STATS });
  } catch {
    // try again at the next alarm
  }
}

// ---------- tab state and badge ----------

const tabKey = (tabId: number) => `tab:${tabId}`;

async function saveTabState(tabId: number, state: Omit<TabState, "updatedAt">) {
  const previous = (await chrome.storage.session.get(tabKey(tabId)))[tabKey(tabId)] as TabState | undefined;
  if (!previous || previous.url !== state.url) await countPage();
  await chrome.storage.session.set({ [tabKey(tabId)]: { ...state, updatedAt: Date.now() } });
  await updateBadge(tabId, state);
}

async function updateBadge(tabId: number, state: Omit<TabState, "updatedAt">) {
  const removed = state.findings.filter((f) => f.action === "removed").length;
  const flagged = state.findings.filter((f) => f.action === "flagged").length;
  let text = "";
  let color = "#16a34a";
  if (state.paused) {
    text = "off";
    color = "#94a3b8";
  } else if (removed) {
    text = String(removed);
    color = "#e11d48";
  } else if (flagged) {
    text = "!";
    color = "#f59e0b";
  } else if (state.pending) {
    text = "…";
    color = "#64748b";
  }
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: removed ? `Untrap removed ${removed} trap${removed === 1 ? "" : "s"} for AI agents` : "Untrap: no traps for AI agents found" }).catch(() => {});
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg: Msg, sender, reply) => {
  switch (msg.type) {
    case "scan":
      if (sender.tab?.id === undefined) return false;
      void scan(sender.tab.id, msg.url, msg.candidates).then(reply);
      return true;
    case "engine-verdict":
      void onVerdict(msg.tabId, msg.hash, msg.verdict).then(() => reply({ ok: true }));
      return true;
    case "report":
      if (sender.tab?.id !== undefined) void saveTabState(sender.tab.id, msg.state).then(() => reply({ ok: true }));
      return true;
    case "get-tab-state":
      void chrome.storage.session.get(tabKey(msg.tabId)).then((r) => reply(r[tabKey(msg.tabId)] ?? null));
      return true;
    case "get-status":
      void askEngine<EngineStatus>({ type: "engine-status" })
        .then(reply)
        .catch((err: Error) => reply({ onDevice: "unsupported", cloud: false, firebase: false, error: err.message } satisfies EngineStatus));
      return true;
    case "self-test":
      void (async () => {
        await ensureEngine();
        return (await chrome.runtime.sendMessage({ type: "engine-self-test" } satisfies Msg)) as unknown;
      })().then(reply, (err: Error) => reply({ ok: false, error: err.message }));
      return true;
    case "get-stats":
      void chrome.storage.local.get("stats").then((r) => reply(r.stats ?? EMPTY_STATS));
      return true;
    default:
      return false; // engine-* messages are for the offscreen document
  }
});

chrome.tabs.onRemoved.addListener((tabId) => void chrome.storage.session.remove(tabKey(tabId)));

chrome.runtime.onInstalled.addListener(async (details) => {
  const stored = await chrome.storage.local.get("settings");
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  await chrome.storage.local.remove("verdicts"); // cache from older versions
  await chrome.alarms.create(STATS_ALARM, { periodInMinutes: 5 });
  if (details.reason === "install") await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === STATS_ALARM) void flushStats();
});
