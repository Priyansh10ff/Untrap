import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { doc, getDoc, getFirestore } from "firebase/firestore/lite";
import type { FirebaseOptions } from "firebase/app";

declare const __FIREBASE_CONFIG__: FirebaseOptions | null;
declare const __RECAPTCHA_SITE_KEY__: string;

// ---------- landing page: live stats ----------

async function loadStats() {
  const pages = document.getElementById("s-pages");
  if (!pages || !__FIREBASE_CONFIG__) return;
  try {
    const app = initializeApp(__FIREBASE_CONFIG__);
    if (__RECAPTCHA_SITE_KEY__) initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(__RECAPTCHA_SITE_KEY__), isTokenAutoRefreshEnabled: true });
    const snap = await getDoc(doc(getFirestore(app), "stats", "global"));
    const s = (snap.data() ?? {}) as Record<string, number>;
    const fmt = (n: number | undefined) => (n ?? 0).toLocaleString();
    pages.textContent = fmt(s.pages);
    document.getElementById("s-threats")!.textContent = fmt(s.threats);
    const ai = (s.onDevice ?? 0) + (s.inCloud ?? 0);
    document.getElementById("s-device")!.textContent = ai ? `${Math.round(((s.onDevice ?? 0) / ai) * 100)}%` : "–";
    document.getElementById("s-blocklist")!.textContent = fmt(s.blocklist);
  } catch (err) {
    console.warn("Stats unavailable", err);
  }
}

// ---------- Attack Lab ----------

const TECHNIQUE: [string, string][] = [
  ["[style*='display:none'], [style*='display: none']", "Hidden with display:none"],
  ["[style*='font-size:1px']", "1px transparent text"],
  ["[style*='color:#ffffff']", "White text on white"],
  ["[style*='left:-9999px']", "Pushed off-screen"],
  [".visually-hidden", "Clipped to 1px"],
];

function revealTraps(on: boolean) {
  document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => el.remove());
  document.querySelectorAll<HTMLElement>(".revealed").forEach((el) => {
    el.classList.remove("revealed");
    el.removeAttribute("data-reveal-label");
  });
  if (!on) return;
  const post = document.querySelector(".post")!;
  for (const [selector, label] of TECHNIQUE) {
    post.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.classList.add("revealed");
      el.setAttribute("data-reveal-label", label);
    });
  }
  const note = (after: Node, label: string, text: string) => {
    const box = document.createElement("div");
    box.className = "revealed";
    box.setAttribute("data-reveal", "");
    box.setAttribute("data-untrap-ui", "");
    box.setAttribute("data-reveal-label", label);
    box.textContent = text;
    after.parentNode?.insertBefore(box, after.nextSibling);
  };
  const walker = document.createTreeWalker(post, NodeFilter.SHOW_COMMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) note(n, "HTML comment", (n as Comment).data.trim());
  const img = post.querySelector("img[alt]");
  if (img) note(img, "Image alt text", img.getAttribute("alt") ?? "");
  const smuggle = document.getElementById("smuggle");
  if (smuggle) {
    const hidden = [...(smuggle.textContent ?? "")].map((c) => c.codePointAt(0)!).filter((cp) => cp >= 0xe0020 && cp <= 0xe007e).map((cp) => String.fromCharCode(cp - 0xe0000)).join("");
    if (hidden) note(smuggle, "Invisible Unicode characters", hidden);
  }
  const meta = document.querySelector('meta[name="ai:instructions"]');
  if (meta) note(post.querySelector("h1")!, "Meta tag in <head>", meta.getAttribute("content") ?? "");
}

function watchUntrap() {
  const status = document.getElementById("lab-status");
  if (!status) return;
  const update = () => {
    const raw = document.documentElement.getAttribute("data-untrap");
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as { removed: number; pending: number };
      status.textContent = s.pending ? `Untrap active · checking ${s.pending}…` : `Untrap active · ${s.removed} traps removed`;
      status.classList.add("on");
    } catch {
      /* ignore */
    }
  };
  update();
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ["data-untrap"] });
}

function initLab() {
  const button = document.getElementById("reveal");
  if (!button) return;
  let on = false;
  button.addEventListener("click", () => {
    on = !on;
    revealTraps(on);
    button.textContent = on ? "Hide the traps" : "Reveal the traps";
  });
  watchUntrap();
}

initLab();
void loadStats();
