import { extractSegments, type SegmentRef } from "../core/extract.ts";
import { actionFor, preRemove, rulesVerdict, selectCandidates } from "../core/policy.ts";
import { stripInvisible } from "../core/text.ts";
import type { Action, Candidate, Finding, ScanResult, Verdict } from "../core/types.ts";
import { DEFAULT_SETTINGS, type Msg, type ScanReply, type Settings, type TabState } from "../core/messages.ts";
import { hideXray, showXray } from "./xray.ts";

/**
 * Runs in every page. Finds hidden text, removes likely traps straight away, asks the engine
 * for verdicts, then applies them. Everything it changes can be put back.
 */

declare const __SITE_URL__: string;

const UI_ATTR = "data-untrap-ui";

/** On our own Attack Lab, tell the page Untrap is running so it can show results. Nowhere else. */
const ON_LAB = (() => {
  try {
    const site = new URL(__SITE_URL__);
    const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    return (location.host === site.host || local) && location.pathname.startsWith("/lab");
  } catch {
    return false;
  }
})();
const MAX_RESCANS = 25;

interface Applied {
  candidate: Candidate;
  ref: SegmentRef;
  action: Action;
  undo: () => void;
}

const applied = new Map<string, Applied>(); // by piece of page (see keyOf)
const decided = new Map<string, Verdict>(); // by text fingerprint, survives re-renders
/** Candidates waiting for the AI, by fingerprint, with every place on the page they appear. */
const waiting = new Map<string, { c: Candidate; refs: SegmentRef[] }>();
/** If the engine never answers (extension reloaded, model stuck), the rules decide. */
const GIVE_UP_MS = 4 * 60_000;
let findings: Finding[] = [];
let mode: ScanResult["mode"] = "none";
let pending = 0;
let paused = false;
let rescans = 0;
let applying = false;
let xrayOn = false;
let observer: MutationObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** A stable key per node (or node + attribute), so the same text in a new node is handled too. */
const nodeIds = new WeakMap<object, number>();
let nodeCounter = 0;
function keyOf(c: Candidate, ref: SegmentRef): string {
  const node = ref.kind === "element" || ref.kind === "attribute" ? ref.el : ref.node;
  let id = nodeIds.get(node);
  if (id === undefined) nodeIds.set(node, (id = ++nodeCounter));
  return `${ref.kind}:${id}:${ref.kind === "attribute" ? ref.attr : ""}:${c.hash}`;
}

async function settings(): Promise<Settings> {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
}

async function scan() {
  const s = await settings();
  paused = !s.enabled || s.paused.includes(location.hostname);
  if (paused) {
    restoreAll();
    report();
    return;
  }

  const { segments, refs } = extractSegments(document, { ignoreAttr: UI_ATTR });
  const found = (await selectCandidates(segments))
    .map((c) => ({ c, ref: refs.get(c.id)! }))
    .filter(({ c, ref }) => ref && !applied.has(keyOf(c, ref)));

  const fresh: Candidate[] = [];
  for (const { c, ref } of found) {
    const known = decided.get(c.hash);
    if (known) {
      // Seen before (the page re-rendered it): apply the same verdict without asking again.
      apply(c, ref, known);
      continue;
    }
    // Hidden text with strong signals goes right away. People can't see it, so nothing changes for them.
    if (preRemove(c)) apply(c, ref, rulesVerdict(c));
    const wait = waiting.get(c.hash);
    if (wait) {
      wait.refs.push(ref);
      continue;
    }
    waiting.set(c.hash, { c, refs: [ref] });
    fresh.push(c);
  }

  pending = waiting.size;
  rebuildFindings();
  report();
  if (!fresh.length) return;

  let reply: ScanReply | undefined;
  try {
    reply = (await chrome.runtime.sendMessage({ type: "scan", url: location.href, candidates: fresh } satisfies Msg)) as ScanReply;
  } catch {
    reply = undefined; // extension reloaded: fall back to the rules
  }
  if (!reply) {
    for (const c of fresh) settle(c.hash, rulesVerdict(c));
    return;
  }
  // Cached verdicts come back at once. The rest arrive one by one as "verdict" messages.
  for (const [hash, v] of Object.entries(reply.verdicts)) settle(hash, v);
  const queued = new Set(reply.queued);
  setTimeout(() => {
    for (const hash of queued) {
      const w = waiting.get(hash);
      if (w) settle(hash, rulesVerdict(w.c));
    }
  }, GIVE_UP_MS);
}

/** A verdict arrived: apply it everywhere that text appears. */
function settle(hash: string, v: Verdict) {
  const w = waiting.get(hash);
  decided.set(hash, v);
  if (!w) return;
  waiting.delete(hash);
  for (const ref of w.refs) apply(w.c, ref, v);
  if (v.source === "on_device" || v.source === "in_cloud") mode = mergeMode(mode, v.source);
  pending = waiting.size;
  rebuildFindings();
  report();
}

function mergeMode(a: ScanResult["mode"], b: ScanResult["mode"]): ScanResult["mode"] {
  if (a === "none") return b;
  if (b === "none" || a === b) return a;
  return "mixed";
}

/** Applies (or re-applies) a verdict to one piece of the page. */
function apply(c: Candidate, ref: SegmentRef, v: Verdict) {
  const key = keyOf(c, ref);
  const action = actionFor(c, v);
  const previous = applied.get(key);
  if (previous?.action === action) return;
  withoutObserving(() => {
    previous?.undo();
    const undo = action === "removed" ? neutralize(ref, c.hidden) : action === "flagged" ? flag(ref) : () => {};
    applied.set(key, { candidate: c, ref, action, undo });
  });
}

function neutralize(ref: SegmentRef, hidden: boolean): () => void {
  switch (ref.kind) {
    case "comment": {
      const { node } = ref;
      const parent = node.parentNode;
      const next = node.nextSibling;
      node.remove();
      return () => parent?.insertBefore(node, next && next.parentNode === parent ? next : null);
    }
    case "attribute": {
      const { el, attr } = ref;
      const value = el.getAttribute(attr);
      el.removeAttribute(attr);
      return () => value !== null && el.setAttribute(attr, value);
    }
    case "invisible-text": {
      const { node } = ref;
      const data = node.data;
      node.data = stripInvisible(data);
      return () => (node.data = data);
    }
    case "element": {
      const { el } = ref;
      const kept = document.createDocumentFragment();
      while (el.firstChild) kept.appendChild(el.firstChild);
      el.setAttribute("data-untrap-removed", "");
      let notice: HTMLElement | undefined;
      if (!hidden) {
        // Visible text changed: tell the reader why it's gone.
        notice = document.createElement("span");
        notice.setAttribute(UI_ATTR, "");
        notice.textContent = "⚠ Untrap removed text here that tried to give orders to AI assistants.";
        notice.style.cssText = "display:inline-block;padding:2px 8px;border-radius:6px;background:#fef2f2;color:#991b1b;font:500 12px/1.6 system-ui,sans-serif;border:1px solid #fecaca";
        el.appendChild(notice);
      }
      return () => {
        notice?.remove();
        el.appendChild(kept);
        el.removeAttribute("data-untrap-removed");
      };
    }
  }
}

function flag(ref: SegmentRef): () => void {
  if (ref.kind !== "element" || !(ref.el instanceof HTMLElement)) return () => {};
  const el = ref.el;
  const outline = el.style.outline;
  // Only an outline: adding text (like a title) would put words on the page that we'd scan ourselves.
  el.style.outline = "2px dashed #f59e0b";
  el.setAttribute("data-untrap-flagged", "");
  return () => {
    el.style.outline = outline;
    el.removeAttribute("data-untrap-flagged");
  };
}

function restoreAll() {
  withoutObserving(() => {
    for (const a of applied.values()) a.undo();
  });
  applied.clear();
  decided.clear();
  waiting.clear();
  pending = 0;
  findings = [];
  mode = "none";
  hideXray();
}

function findingOf(a: Applied): Finding {
  return { candidate: a.candidate, verdict: decided.get(a.candidate.hash) ?? rulesVerdict(a.candidate), action: a.action };
}

function rebuildFindings() {
  // One entry per distinct text, even if the page repeats it.
  const byHash = new Map<string, Finding>();
  for (const a of applied.values()) if (!byHash.has(a.candidate.hash)) byHash.set(a.candidate.hash, findingOf(a));
  findings = [...byHash.values()];
  if (xrayOn) showXray(findingsWithRefs());
}

function findingsWithRefs() {
  return [...applied.values()].filter((a) => a.action !== "kept").map((a) => ({ finding: findingOf(a), ref: a.ref }));
}

function report() {
  const state: Omit<TabState, "updatedAt"> = {
    url: location.href,
    host: location.hostname,
    scanned: true,
    paused,
    // Keep the message small: long page text is clipped in the popup anyway.
    findings: findings.map((f) => ({ ...f, candidate: { ...f.candidate, text: f.candidate.text.slice(0, 600) } })),
    mode,
    pending,
  };
  chrome.runtime.sendMessage({ type: "report", state } satisfies Msg).catch(() => {});
  if (ON_LAB) {
    const removed = findings.filter((f) => f.action === "removed").length;
    withoutObserving(() => document.documentElement.setAttribute("data-untrap", JSON.stringify({ removed, pending, mode })));
  }
}

function withoutObserving(fn: () => void) {
  applying = true;
  try {
    fn();
  } finally {
    observer?.takeRecords();
    applying = false;
  }
}

function watch() {
  observer = new MutationObserver((records) => {
    if (applying || paused) return;
    const relevant = records.some((r) => {
      const target = r.target instanceof Element ? r.target : r.target.parentElement;
      return !target?.closest(`[${UI_ATTR}]`);
    });
    if (!relevant || rescans >= MAX_RESCANS) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      rescans++;
      void scan();
    }, 1200);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden", "alt", "title", "aria-label", "content"] });
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  if (msg.type === "verdict") {
    settle(msg.hash, msg.verdict);
    reply({ ok: true });
  } else if (msg.type === "xray") {
    xrayOn = msg.on;
    if (xrayOn) showXray(findingsWithRefs());
    else hideXray();
    reply({ ok: true });
  } else if (msg.type === "rescan") {
    restoreAll();
    void scan().then(() => reply({ ok: true }));
    return true;
  } else if (msg.type === "restore") {
    restoreAll();
    report();
    reply({ ok: true });
  }
  return false;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    restoreAll();
    void scan();
  }
});

void scan().then(watch);
