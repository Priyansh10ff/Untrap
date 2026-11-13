import type { SegmentRef } from "../core/extract.ts";
import { CATEGORY_LABELS, type Finding } from "../core/types.ts";
import { clip } from "../core/text.ts";

/**
 * X-ray mode: shows people what was hidden on the page for AI agents. Each finding gets a red
 * box on the page where it was hidden, and a panel lists them all with the hidden text.
 */

const HOST_ID = "untrap-xray";

const TECHNIQUE_LABELS: Record<string, string> = {
  "html-comment": "HTML comment",
  "display-none": "Hidden element",
  "visibility-hidden": "Invisible element",
  transparent: "Transparent text",
  "tiny-font": "Tiny text",
  "same-color": "Text same color as background",
  offscreen: "Pushed off-screen",
  clipped: "Clipped to nothing",
  "aria-hidden": "Hidden element",
  attribute: "Hidden in an attribute",
  meta: "Meta tag",
  noscript: "noscript block",
  "invisible-unicode": "Invisible characters",
  visible: "Visible text",
};

const SOURCE_LABELS: Record<string, string> = {
  on_device: "On-device AI",
  in_cloud: "Cloud AI",
  blocklist: "Shared blocklist",
  rules: "Rules",
  cache: "Cache",
};

export function hideXray() {
  document.getElementById(HOST_ID)?.remove();
}

export function showXray(items: { finding: Finding; ref: SegmentRef }[]) {
  hideXray();
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-untrap-ui", "");
  host.style.cssText = `position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;`;
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style>`;

  const layer = document.createElement("div");
  layer.className = "layer";
  root.appendChild(layer);

  items.forEach(({ finding, ref }, i) => {
    const anchor = anchorOf(ref);
    if (!anchor) return;
    const { rect, exact } = anchor;
    if (exact) {
      // The element itself is on screen (visible text, an image with a hidden alt): outline it.
      const box = document.createElement("div");
      box.className = `box ${finding.action}`;
      box.style.left = `${rect.left + scrollX - 3}px`;
      box.style.top = `${rect.top + scrollY - 3}px`;
      box.style.width = `${Math.max(rect.width, 24) + 6}px`;
      box.style.height = `${Math.max(rect.height, 18) + 6}px`;
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = `${i + 1}`;
      box.appendChild(tag);
      layer.appendChild(box);
    } else {
      // Hidden text has no box of its own: pin the spot where it sits in the page.
      const pin = document.createElement("div");
      pin.className = `pin ${finding.action}`;
      pin.style.left = `${rect.left + scrollX}px`;
      pin.style.top = `${rect.top + scrollY - 11}px`;
      pin.innerHTML = `<b>${i + 1}</b><span>hidden here</span>`;
      layer.appendChild(pin);
    }
  });

  const panel = document.createElement("aside");
  panel.className = "panel";
  const blocked = new Set(items.filter((x) => x.finding.action === "removed").map((x) => x.finding.candidate.hash)).size;
  panel.innerHTML = `
    <header>
      <div class="brand"><span class="logo"></span>Untrap X-ray</div>
      <button class="close" aria-label="Close X-ray">×</button>
    </header>
    <p class="lead">${items.length ? `${blocked} trap${blocked === 1 ? "" : "s"} removed from this page. This is what was hidden for AI agents:` : "Nothing on this page is trying to give orders to AI agents."}</p>
    <ol class="list"></ol>`;
  const list = panel.querySelector(".list")!;
  items.forEach(({ finding }, i) => {
    const { candidate: c, verdict: v } = finding;
    const li = document.createElement("li");
    li.className = finding.action;
    const head = document.createElement("div");
    head.className = "row";
    head.innerHTML = `<b class="num">${i + 1}</b><span class="cat"></span><span class="chip"></span>`;
    head.querySelector(".cat")!.textContent = CATEGORY_LABELS[v.category];
    head.querySelector(".chip")!.textContent = SOURCE_LABELS[v.source] ?? v.source;
    const where = document.createElement("div");
    where.className = "where";
    where.textContent = `${TECHNIQUE_LABELS[c.technique] ?? c.technique} · ${c.attr ? `${c.where} ${c.attr}` : c.where}`;
    const quote = document.createElement("blockquote");
    quote.textContent = clip(c.text, 280);
    const reason = document.createElement("p");
    reason.className = "reason";
    reason.textContent = v.reason;
    li.append(head, where, quote, reason);
    list.appendChild(li);
  });
  panel.querySelector(".close")!.addEventListener("click", () => {
    hideXray();
    chrome.runtime.sendMessage({ type: "xray-closed" }).catch(() => {});
  });
  root.appendChild(panel);
  document.documentElement.appendChild(host);
}

const hasBox = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
};

/**
 * Where to mark a finding. Visible things get an outline. Hidden things are pinned where they
 * sit: just after the closest visible element before them, or before the next one.
 */
function anchorOf(ref: SegmentRef): { rect: DOMRect; exact: boolean } | null {
  if (ref.kind === "attribute" && ref.el.tagName === "META") return null;
  if (ref.kind === "invisible-text") {
    const p = ref.node.parentElement;
    return p && hasBox(p) ? { rect: p.getBoundingClientRect(), exact: true } : null;
  }
  const node: Node = ref.kind === "comment" ? ref.node : ref.el;
  if (node instanceof Element && hasBox(node) && ref.kind !== "element") return { rect: node.getBoundingClientRect(), exact: true };
  if (node instanceof Element && hasBox(node) && node.textContent?.trim()) return { rect: node.getBoundingClientRect(), exact: true };
  for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
    if (sib instanceof Element && hasBox(sib)) {
      const r = sib.getBoundingClientRect();
      return { rect: new DOMRect(r.left, r.bottom + 4, r.width, 0), exact: false };
    }
  }
  for (let sib = node.nextSibling; sib; sib = sib.nextSibling) {
    if (sib instanceof Element && hasBox(sib)) {
      const r = sib.getBoundingClientRect();
      return { rect: new DOMRect(r.left, r.top - 4, r.width, 0), exact: false };
    }
  }
  for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
    if (hasBox(p)) {
      const r = p.getBoundingClientRect();
      return { rect: new DOMRect(r.left, r.top, r.width, 0), exact: false };
    }
  }
  return null;
}

const CSS = `
:host { all: initial; }
.layer { position: absolute; left: 0; top: 0; pointer-events: none; }
.box { position: absolute; border: 2px solid #e11d48; border-radius: 6px; background: rgba(225, 29, 72, .08); box-shadow: 0 0 0 4px rgba(225, 29, 72, .12); }
.box.flagged { border-color: #f59e0b; background: rgba(245, 158, 11, .08); box-shadow: 0 0 0 4px rgba(245, 158, 11, .12); }
.tag { position: absolute; top: -11px; left: -11px; width: 20px; height: 20px; border-radius: 50%; background: #e11d48; color: #fff; font: 700 11px/20px system-ui, sans-serif; text-align: center; }
.flagged .tag { background: #f59e0b; }
.pin { position: absolute; display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px 0 3px; border-radius: 99px; background: #e11d48; color: #fff; font: 600 12px/22px system-ui, sans-serif; box-shadow: 0 6px 16px -6px rgba(225, 29, 72, .7); white-space: nowrap; }
.pin b { width: 16px; height: 16px; border-radius: 50%; background: #fff; color: #e11d48; font-size: 10px; line-height: 16px; text-align: center; }
.pin::after { content: ""; position: absolute; left: 0; right: -9999px; top: 10px; height: 2px; background: linear-gradient(90deg, rgba(225, 29, 72, .5), transparent 600px); z-index: -1; pointer-events: none; }
.pin.flagged { background: #f59e0b; }
.pin.flagged b { color: #b45309; }
.panel { position: fixed; top: 16px; right: 16px; width: 360px; max-height: calc(100vh - 32px); overflow: auto; background: #fff; color: #0f172a;
  border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 24px 60px -20px rgba(15, 23, 42, .45); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; pointer-events: auto; }
header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #f1f5f9; position: sticky; top: 0; background: #fff; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 700; }
.logo { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg, #e11d48, #f43f5e); }
.close { border: 0; background: #f1f5f9; width: 28px; height: 28px; border-radius: 8px; font-size: 18px; cursor: pointer; color: #334155; }
.lead { margin: 12px 14px; color: #475569; }
.list { list-style: none; margin: 0; padding: 0 14px 14px; display: grid; gap: 10px; }
li { border: 1px solid #fecdd3; background: #fff1f2; border-radius: 10px; padding: 10px 12px; }
li.flagged { border-color: #fde68a; background: #fffbeb; }
.row { display: flex; align-items: center; gap: 8px; }
.num { width: 20px; height: 20px; border-radius: 50%; background: #e11d48; color: #fff; font-size: 11px; display: grid; place-items: center; flex: none; }
li.flagged .num { background: #f59e0b; }
.cat { font-weight: 600; flex: 1; }
.chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: #fff; border: 1px solid #e2e8f0; color: #334155; white-space: nowrap; }
.where { margin-top: 4px; font-size: 12px; color: #64748b; }
blockquote { margin: 8px 0 0; padding: 8px 10px; background: #fff; border-radius: 8px; border: 1px dashed #fda4af; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; color: #881337; word-break: break-word; }
.reason { margin: 6px 0 0; font-size: 12px; color: #475569; }
`;
