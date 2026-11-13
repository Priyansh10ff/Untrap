import { DEFAULT_SETTINGS, type EngineStatus, type Msg, type Settings, type StatsDelta, type TabState } from "../core/messages.ts";
import { CATEGORY_LABELS, type Finding } from "../core/types.ts";
import { clip } from "../core/text.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const SOURCE: Record<string, string> = { on_device: "On-device AI", in_cloud: "Cloud AI", blocklist: "Blocklist", rules: "Rules", cache: "Checked before" };
const WHERE: Record<string, string> = {
  "html-comment": "HTML comment",
  "display-none": "Hidden element",
  "visibility-hidden": "Invisible element",
  transparent: "Transparent text",
  "tiny-font": "1px text",
  "same-color": "Same color as background",
  offscreen: "Off-screen",
  clipped: "Clipped to nothing",
  "aria-hidden": "Hidden element",
  attribute: "Attribute",
  meta: "Meta tag",
  noscript: "noscript",
  "invisible-unicode": "Invisible characters",
  visible: "Visible text",
};

let tab: chrome.tabs.Tab | undefined;
let state: TabState | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let xrayOn = false;

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
}

async function saveSettings(next: Partial<Settings>) {
  settings = { ...settings, ...next };
  await chrome.storage.local.set({ settings });
}

function host(): string {
  if (state?.host) return state.host;
  try {
    return tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    return "";
  }
}

function render() {
  const enabled = $<HTMLInputElement>("enabled");
  enabled.checked = settings.enabled;
  const title = $("status-title");
  const sub = $("status-sub");
  const icon = $("status-icon");
  const box = $("status");
  const list = $("findings");
  list.replaceChildren();

  const isWeb = Boolean(state) || /^https?:/.test(tab?.url ?? "");
  const paused = settings.paused.includes(host());
  $("pause").textContent = paused ? "Resume on this site" : "Pause on this site";
  $<HTMLButtonElement>("pause").disabled = !isWeb;
  $<HTMLButtonElement>("xray").disabled = !isWeb || !state || paused || !settings.enabled;
  $("xray").textContent = xrayOn ? "Hide X-ray" : "X-ray this page";

  let kind: "clean" | "threat" | "warn" | "idle" = "idle";
  if (!isWeb) {
    title.textContent = "Nothing to check here";
    sub.textContent = "Untrap checks web pages (http and https).";
  } else if (!settings.enabled) {
    title.textContent = "Untrap is off";
    sub.textContent = "Turn it on to protect AI agents on every page.";
  } else if (paused || state?.paused) {
    title.textContent = "Paused on this site";
    sub.textContent = host();
  } else if (!state) {
    title.textContent = "Not checked yet";
    sub.textContent = "Reload the page to check it.";
  } else {
    const shown = state.findings.filter((f) => f.action !== "kept");
    const removed = shown.filter((f) => f.action === "removed").length;
    const flagged = shown.filter((f) => f.action === "flagged").length;
    const checked = state.findings.length;
    if (removed) {
      kind = "threat";
      title.textContent = `${removed} trap${removed === 1 ? "" : "s"} removed`;
    } else if (flagged) {
      kind = "warn";
      title.textContent = `${flagged} suspicious bit${flagged === 1 ? "" : "s"} flagged`;
    } else {
      kind = "clean";
      title.textContent = "This page is clean";
    }
    sub.textContent = state.pending
      ? `Checking ${state.pending} more with AI…`
      : checked
        ? `${checked} suspicious bit${checked === 1 ? "" : "s"} checked ${modeText(state.mode)}`
        : "No hidden instructions for AI agents.";
    shown.forEach((f, i) => list.appendChild(item(f, i)));
  }
  box.className = `status ${kind}`;
  icon.textContent = { clean: "✓", threat: "!", warn: "?", idle: "·" }[kind];
}

function modeText(mode: TabState["mode"]) {
  if (mode === "on_device") return "on your device.";
  if (mode === "in_cloud") return "with cloud AI.";
  if (mode === "mixed") return "on your device and in the cloud.";
  return "with rules.";
}

function item(f: Finding, i: number): HTMLLIElement {
  const li = document.createElement("li");
  li.className = f.action;
  const head = document.createElement("div");
  head.className = "row";
  const num = document.createElement("b");
  num.className = "num";
  num.textContent = String(i + 1);
  const cat = document.createElement("span");
  cat.className = "cat";
  cat.textContent = CATEGORY_LABELS[f.verdict.category];
  const chip = document.createElement("span");
  chip.className = `chip ${f.verdict.source}`;
  chip.textContent = SOURCE[f.verdict.source] ?? f.verdict.source;
  head.append(num, cat, chip);
  const where = document.createElement("div");
  where.className = "where";
  where.textContent = WHERE[f.candidate.technique] ?? f.candidate.technique;
  const quote = document.createElement("q");
  quote.textContent = clip(f.candidate.text, 140);
  li.append(head, where, quote);
  return li;
}

async function renderEngine() {
  const text = $("engine-text");
  const dot = document.querySelector<HTMLElement>("#engine .dot")!;
  try {
    const s = (await chrome.runtime.sendMessage({ type: "get-status" } satisfies Msg)) as EngineStatus;
    if (s.onDevice === "available") {
      text.textContent = "Gemini Nano is ready on this device";
      dot.className = "dot ok";
    } else if (s.onDevice === "downloading") {
      text.textContent = "Gemini Nano is downloading…";
      dot.className = "dot warn";
    } else if (s.onDevice === "downloadable") {
      text.innerHTML = `Gemini Nano isn't downloaded. <a href="welcome.html" target="_blank">Set it up</a>`;
      dot.className = "dot warn";
    } else {
      text.textContent = s.cloud ? "On-device AI unavailable: using cloud AI" : "No AI available: using rules";
      dot.className = s.cloud ? "dot warn" : "dot off";
    }
  } catch {
    text.textContent = "Engine not running";
    dot.className = "dot off";
  }
}

async function renderStats() {
  const s = (await chrome.runtime.sendMessage({ type: "get-stats" } satisfies Msg)) as StatsDelta;
  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  $("stats").textContent = `${plural(s.pages, "page")} checked · ${plural(s.threats, "trap")} caught`;
}

async function send(msg: Msg) {
  if (tab?.id === undefined) return;
  return chrome.tabs.sendMessage(tab.id, msg).catch(() => undefined);
}

$("enabled").addEventListener("change", async (e) => {
  await saveSettings({ enabled: (e.target as HTMLInputElement).checked });
  xrayOn = false;
  render();
});

$("pause").addEventListener("click", async () => {
  const h = host();
  if (!h) return;
  const paused = settings.paused.includes(h) ? settings.paused.filter((x) => x !== h) : [...settings.paused, h];
  await saveSettings({ paused });
  xrayOn = false;
  render();
});

$("xray").addEventListener("click", async () => {
  xrayOn = !xrayOn;
  await send({ type: "xray", on: xrayOn });
  render();
  if (xrayOn) window.close();
});

async function refresh() {
  if (tab?.id === undefined) return;
  state = (await chrome.runtime.sendMessage({ type: "get-tab-state", tabId: tab.id } satisfies Msg)) as TabState | null;
  // A report from a previous page in this tab doesn't count.
  const strip = (u: string) => u.split("#")[0];
  if (state && tab.url && strip(state.url) !== strip(tab.url)) state = null;
  render();
}

async function main() {
  // ?tab=<id> lets the popup be opened as a page for a specific tab (used by tests and screenshots).
  const forced = Number(new URLSearchParams(location.search).get("tab"));
  [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  await loadSettings();
  await refresh();
  void renderEngine();
  void renderStats();
  // Keep up while the model finishes.
  chrome.storage.session.onChanged.addListener((changes) => {
    if (tab?.id !== undefined && changes[`tab:${tab.id}`]) void refresh();
  });
}

void main();
