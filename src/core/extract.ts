import type { Segment, Technique } from "./types.ts";
import { decodeTagChars, hasInvisibleChars, normalize } from "./text.ts";

/**
 * Finds every piece of text on a page that an AI agent might read, and works out whether a
 * person can see it. Runs in the page (content script) because it needs real computed styles
 * and layout.
 */

export type SegmentRef =
  | { kind: "element"; el: Element }
  | { kind: "comment"; node: Comment }
  | { kind: "attribute"; el: Element; attr: string }
  | { kind: "invisible-text"; node: Text };

export interface Extraction {
  segments: Segment[];
  refs: Map<string, SegmentRef>;
  /** Text nodes looked at, for stats and tests. */
  textNodes: number;
}

export interface ExtractOptions {
  /** Stops after this many text nodes, so huge pages stay fast. */
  maxTextNodes?: number;
  /** Elements with this attribute (our own UI) are skipped. */
  ignoreAttr?: string;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "TITLE", "SVG", "MATH", "IFRAME", "OBJECT", "CANVAS", "VIDEO", "AUDIO", "SELECT", "OPTION"]);
const BLOCK_SELECTOR = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre,figcaption,dd,dt,label,summary,caption,button,a";
const TEXT_ATTRS = ["alt", "title", "aria-label", "aria-description", "placeholder"];
const SKIP_META = /^(viewport|charset|theme-color|color-scheme|robots|googlebot|referrer|format-detection|generator|msapplication|apple-|google-site-verification|csrf|og:image|og:url|twitter:image|og:type|og:locale)/i;
const MAX_SEGMENT_CHARS = 4000;
const MIN_ATTR_CHARS = 30;

interface Hidden {
  technique: Technique;
  /** The outermost element that hides the text. */
  root: Element;
}

export function extractSegments(doc: Document, options: ExtractOptions = {}): Extraction {
  const win = doc.defaultView!;
  const maxTextNodes = options.maxTextNodes ?? 30_000;
  const ignoreAttr = options.ignoreAttr ?? "data-untrap-ui";
  const segments: Segment[] = [];
  const refs = new Map<string, SegmentRef>();
  let nextId = 1;
  const add = (seg: Omit<Segment, "id">, ref: SegmentRef) => {
    const text = normalize(seg.text).slice(0, MAX_SEGMENT_CHARS);
    if (!text) return;
    const id = `s${nextId++}`;
    segments.push({ ...seg, id, text });
    refs.set(id, ref);
  };

  // Computed-style lookups are the expensive part, so each element is checked once.
  const hiddenMemo = new Map<Element, Hidden | null>();
  const opacityMemo = new Map<Element, number>();
  const docWidth = Math.max(doc.documentElement.scrollWidth, win.innerWidth);
  const docHeight = Math.max(doc.documentElement.scrollHeight, win.innerHeight);

  const cumulativeOpacity = (el: Element | null): number => {
    if (!el) return 1;
    const cached = opacityMemo.get(el);
    if (cached !== undefined) return cached;
    const own = Number.parseFloat(win.getComputedStyle(el).opacity);
    const value = (Number.isFinite(own) ? own : 1) * cumulativeOpacity(el.parentElement);
    opacityMemo.set(el, value);
    return value;
  };

  const ownTechnique = (el: Element): Technique | null => {
    const cs = win.getComputedStyle(el);
    if (cs.display === "none") return "display-none";
    if (Number.parseFloat(cs.opacity) < 0.05) return "transparent";
    if (cs.contentVisibility === "hidden") return "display-none";
    const clip = cs.clip;
    const clipPath = cs.clipPath;
    if ((clip && /rect\(\s*0(px)?,?\s+0(px)?,?\s+0(px)?,?\s+0(px)?\s*\)/.test(clip)) || /inset\(\s*(50|100)%/.test(clipPath)) return "clipped";
    if (Number.parseFloat(cs.textIndent) < -999) return "offscreen";
    if (cs.position === "absolute" || cs.position === "fixed") {
      const r = el.getBoundingClientRect();
      const left = r.left + win.scrollX;
      const top = r.top + win.scrollY;
      if (r.right + win.scrollX < -50 || r.bottom + win.scrollY < -50 || left > docWidth + 200 || top > docHeight + 2000) return "offscreen";
      if (r.width <= 1 && r.height <= 1 && cs.overflow !== "visible") return "clipped";
    }
    return null;
  };

  const hiddenBy = (el: Element | null): Hidden | null => {
    if (!el || el === doc.documentElement || el === doc.body) return null;
    const cached = hiddenMemo.get(el);
    if (cached !== undefined) return cached;
    // An ancestor's reason wins, so the whole hidden block becomes one segment.
    const parent = hiddenBy(el.parentElement);
    const result = parent ?? (() => {
      const t = ownTechnique(el);
      return t ? { technique: t, root: el } : null;
    })();
    hiddenMemo.set(el, result);
    return result;
  };

  /** Hidden by its text style rather than by its box: tiny, invisible or same-color text. */
  const styleMemo = new Map<Element, Technique | null>();
  const textStyleTechnique = (el: Element): Technique | null => {
    const cached = styleMemo.get(el);
    if (cached !== undefined) return cached;
    const result = computeTextStyleTechnique(el);
    styleMemo.set(el, result);
    return result;
  };
  const computeTextStyleTechnique = (el: Element): Technique | null => {
    const cs = win.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return "visibility-hidden";
    if (Number.parseFloat(cs.fontSize) < 3) return "tiny-font";
    if (cumulativeOpacity(el) < 0.05) return "transparent";
    const color = parseColor(cs.color);
    if (color && color[3] < 0.05) return "transparent";
    if (cs.webkitTextFillColor && parseColor(cs.webkitTextFillColor)?.[3] === 0) return "transparent";
    const bg = backgroundOf(el);
    if (color && bg && contrast(color, bg) < 1.12) return "same-color";
    return null;
  };

  const backgroundOf = (el: Element): Rgba | null => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const cs = win.getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null; // can't tell over an image
      const c = parseColor(cs.backgroundColor);
      if (c && c[3] > 0.9) return c;
    }
    return [255, 255, 255, 1];
  };

  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : "";
    return `<${tag}${id}${cls}>`;
  };

  // 1. Text nodes, grouped into hidden blocks and visible blocks.
  const hiddenGroups = new Map<Element, Technique>();
  const styleHidden = new Map<Element, Technique>();
  const visibleBlocks = new Set<Element>();
  let textNodes = 0;

  const roots: (Document | ShadowRoot)[] = [doc];
  for (let r = 0; r < roots.length; r++) {
    const root = roots[r]!;
    const walker = doc.createTreeWalker(root, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          const el = node as Element;
          if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute(ignoreAttr)) return 2; // FILTER_REJECT
          if (el.shadowRoot) roots.push(el.shadowRoot);
          return 3; // FILTER_SKIP: walk children
        }
        return 1; // FILTER_ACCEPT text
      },
    });
    for (let node = walker.nextNode(); node && textNodes < maxTextNodes; node = walker.nextNode()) {
      const textNode = node as Text;
      const data = textNode.data;
      if (!data.trim()) continue;
      textNodes++;
      const parent = textNode.parentElement;
      if (!parent || parent.closest("head")) continue;

      if (hasInvisibleChars(data)) {
        const smuggled = decodeTagChars(data);
        if (smuggled.trim().length >= 8) {
          add({ text: smuggled, technique: "invisible-unicode", hidden: true, where: describe(parent) }, { kind: "invisible-text", node: textNode });
        }
      }

      const hidden = hiddenBy(parent);
      if (hidden) {
        if (!hiddenGroups.has(hidden.root)) hiddenGroups.set(hidden.root, hidden.technique);
        continue;
      }
      if (normalize(data).length < 12) continue;
      const styled = textStyleTechnique(parent);
      if (styled) {
        // Group by the nearest block so a hidden paragraph becomes one segment.
        const block = parent.closest(BLOCK_SELECTOR) ?? parent;
        const blockStyled = block === parent ? styled : textStyleTechnique(block);
        styleHidden.set(blockStyled ? block : parent, styled);
        continue;
      }
      visibleBlocks.add(parent.closest(BLOCK_SELECTOR) ?? parent);
    }
  }

  for (const [el, technique] of hiddenGroups) {
    add({ text: textOf(el), technique, hidden: true, where: describe(el) }, { kind: "element", el });
  }
  for (const [el, technique] of styleHidden) {
    if (hasHiddenAncestorIn(el, styleHidden)) continue;
    add({ text: textOf(el), technique, hidden: true, where: describe(el) }, { kind: "element", el });
  }
  for (const el of visibleBlocks) {
    if (hasAncestorIn(el, visibleBlocks)) continue;
    add({ text: textOf(el), technique: "visible", hidden: false, where: describe(el) }, { kind: "element", el });
  }

  // 2. HTML comments, anywhere in the document.
  const commentWalker = doc.createTreeWalker(doc, 0x80 /* SHOW_COMMENT */);
  for (let node = commentWalker.nextNode(); node; node = commentWalker.nextNode()) {
    const comment = node as Comment;
    const text = comment.data.trim();
    if (text.length < 20 || /^\[if |^<!\[endif|^\/?\$|^react-|^ko |^\/ko/.test(text)) continue;
    const parent = comment.parentElement;
    add({ text, technique: "html-comment", hidden: true, where: `comment in ${parent ? describe(parent) : "document"}` }, { kind: "comment", node: comment });
  }

  // 3. Attributes people rarely see but agents often read.
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    if (el.closest(`[${ignoreAttr}]`)) continue;
    if (el.tagName === "META") {
      const content = el.getAttribute("content") ?? "";
      const name = el.getAttribute("name") ?? el.getAttribute("property") ?? el.getAttribute("http-equiv") ?? "";
      if (content.length >= MIN_ATTR_CHARS && !SKIP_META.test(name)) {
        add({ text: content, technique: "meta", hidden: true, where: `meta[${name || "?"}]`, attr: "content" }, { kind: "attribute", el, attr: "content" });
      }
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isText = TEXT_ATTRS.includes(name) || (name.startsWith("data-") && name !== ignoreAttr);
      if (!isText || attr.value.length < MIN_ATTR_CHARS) continue;
      if (name.startsWith("data-") && !/\s/.test(attr.value.trim())) continue; // ids, urls, json blobs
      add({ text: attr.value, technique: "attribute", hidden: true, where: describe(el), attr: name }, { kind: "attribute", el, attr: name });
    }
  }

  // 4. <noscript> content reaches agents that read raw HTML.
  for (const el of Array.from(doc.querySelectorAll("noscript"))) {
    const text = el.textContent ?? "";
    if (normalize(text).length >= MIN_ATTR_CHARS) add({ text: stripTags(text), technique: "noscript", hidden: true, where: describe(el) }, { kind: "element", el });
  }

  return { segments, refs, textNodes };
}

function textOf(el: Element): string {
  // textContent includes hidden children, which is what an agent reading the DOM would see.
  return el.textContent ?? "";
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function hasAncestorIn(el: Element, set: Set<Element>): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return true;
  return false;
}

function hasHiddenAncestorIn(el: Element, map: Map<Element, unknown>): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (map.has(p)) return true;
  return false;
}

/** Parses rgb()/rgba() into [r, g, b, a]. Returns null for anything else. */
export type Rgba = [number, number, number, number];

export function parseColor(value: string | undefined | null): Rgba | null {
  if (!value) return null;
  if (value === "transparent") return [0, 0, 0, 0];
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (!m) return null;
  let a = m[4] === undefined ? 1 : Number.parseFloat(m[4]);
  if (m[4]?.endsWith("%")) a /= 100;
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

/** WCAG contrast ratio between two colors. */
export function contrast(a: Rgba, b: Rgba): number {
  const lum = (c: Rgba) => {
    const [r, g, bl] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
