import { doc, getDoc, getFirestore, increment, serverTimestamp, setDoc, type Firestore } from "firebase/firestore/lite";
import type { GenerativeModel } from "firebase/ai";
import { buildPrompt, makeNonce, parseVerdict } from "../core/prompt.ts";
import { needsSecondOpinion, rulesVerdict } from "../core/policy.ts";
import { CATEGORIES, type Candidate, type ScanResult, type Verdict } from "../core/types.ts";
import type { EngineStatus, Msg, Settings, StatsDelta } from "../core/messages.ts";
import { firebaseApp, firebaseConfigured, getModels, onDeviceAvailability } from "./firebase.ts";

/**
 * The engine. Lives in an offscreen document so the model session and Firebase stay warm.
 *
 * For each suspicious piece of text:
 *   1. Shared blocklist: if other Untrap users already confirmed it, done.
 *   2. First pass with Firebase AI Logic hybrid inference: Gemini Nano on this device when it's
 *      ready (free, private), otherwise Gemini in the cloud.
 *   3. If the on-device model is unsure, a larger cloud model gives a second opinion.
 *   4. Confirmed attacks are added to the shared blocklist so everyone is protected.
 */

const ON_DEVICE_CHARS = 1200;
const CLOUD_CHARS = 4000;
const CALL_TIMEOUT = 30_000;

let db: Firestore | undefined;
function firestore(): Firestore | undefined {
  const app = firebaseApp();
  if (!app) return undefined;
  db ??= getFirestore(app);
  return db;
}

/** Nano handles one prompt at a time, so pages queue up. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("model timed out")), ms))]);
}

async function ask(model: GenerativeModel, c: Candidate, maxChars: number): Promise<Verdict | null> {
  const result = await withTimeout(model.generateContent(buildPrompt(c, { maxChars, nonce: makeNonce() })), CALL_TIMEOUT);
  const source = result.response.inferenceSource === "on_device" ? "on_device" : "in_cloud";
  return parseVerdict(result.response.text(), source);
}

async function lookupBlocklist(candidates: Candidate[]): Promise<Map<string, Verdict>> {
  const store = firestore();
  const hits = new Map<string, Verdict>();
  if (!store) return hits;
  await Promise.all(
    candidates.map(async (c) => {
      try {
        const snap = await getDoc(doc(store, "blocklist", c.hash));
        if (!snap.exists()) return;
        const data = snap.data() as { category?: string; reason?: string; reports?: number };
        const category = CATEGORIES.includes(data.category as never) ? (data.category as Verdict["category"]) : "other";
        hits.set(c.hash, {
          verdict: "attack",
          category,
          confidence: 1,
          reason: data.reason || "Other Untrap users already reported this trap.",
          source: "blocklist",
        });
      } catch {
        // offline or blocked: the models still run
      }
    }),
  );
  return hits;
}

async function report(c: Candidate, v: Verdict, url: string) {
  const store = firestore();
  if (!store) return;
  const ref = doc(store, "blocklist", c.hash);
  try {
    const snap = await getDoc(ref);
    const base = { category: v.category, reason: v.reason.slice(0, 200), lastSeen: serverTimestamp() };
    if (snap.exists()) await setDoc(ref, { ...base, reports: increment(1) }, { merge: true });
    else await setDoc(ref, { ...base, reports: 1, firstSeen: serverTimestamp(), host: new URL(url).hostname.slice(0, 253) });
  } catch (err) {
    console.warn("Untrap: couldn't update the shared blocklist", err);
  }
}

/** Worth adding to the shared blocklist: confirmed by the cloud, or the device is very sure. */
function shouldReport(v: Verdict): boolean {
  if (v.verdict !== "attack") return false;
  return v.source === "in_cloud" ? v.confidence >= 0.7 : v.source === "on_device" && v.confidence >= 0.9;
}

async function classify(url: string, candidates: Candidate[], settings: Settings): Promise<ScanResult> {
  const verdicts: Record<string, Verdict> = {};
  const models = getModels();
  const device = await onDeviceAvailability();
  const blocked = settings.share ? await lookupBlocklist(candidates) : new Map<string, Verdict>();
  let usedDevice = false;
  let usedCloud = false;

  for (const c of candidates) {
    const known = blocked.get(c.hash);
    if (known) {
      verdicts[c.hash] = known;
      continue;
    }
    let v: Verdict | null = null;
    // First pass. With cloud checks off, only the device may run.
    const first = settings.cloud ? models?.hybrid : device === "available" ? models?.deviceOnly : undefined;
    if (first) {
      try {
        v = await serial(() => ask(first, c, ON_DEVICE_CHARS));
      } catch (err) {
        console.warn("Untrap: first pass failed", err);
      }
    }
    // Second opinion from a larger cloud model when the device is unsure.
    if (v && v.source === "on_device" && settings.cloud && models && needsSecondOpinion(c, v)) {
      usedDevice = true;
      try {
        v = (await serial(() => ask(models.cloud, c, CLOUD_CHARS))) ?? v;
      } catch (err) {
        console.warn("Untrap: second opinion failed", err);
      }
    }
    if (v?.source === "on_device") usedDevice = true;
    if (v?.source === "in_cloud") usedCloud = true;
    v ??= rulesVerdict(c);
    verdicts[c.hash] = v;
    if (settings.share && shouldReport(v)) void report(c, v, url);
  }

  const mode = usedDevice && usedCloud ? "mixed" : usedDevice ? "on_device" : usedCloud ? "in_cloud" : "none";
  return { verdicts, mode };
}

async function status(): Promise<EngineStatus> {
  return { onDevice: await onDeviceAvailability(), cloud: firebaseConfigured, firebase: firebaseConfigured };
}

async function addStats(delta: StatsDelta) {
  const store = firestore();
  if (!store) return;
  const capped = (n: number) => Math.min(Math.max(0, Math.round(n)), 1000);
  await setDoc(
    doc(store, "stats", "global"),
    {
      pages: increment(capped(delta.pages)),
      threats: increment(capped(delta.threats)),
      onDevice: increment(capped(delta.onDevice)),
      inCloud: increment(capped(delta.inCloud)),
      blocklist: increment(capped(delta.blocklist)),
    },
    { merge: true },
  );
}

chrome.runtime.onMessage.addListener((msg: Msg, _sender, reply) => {
  switch (msg.type) {
    case "engine-classify":
      void classify(msg.url, msg.candidates, msg.settings).then(reply, (err: Error) => {
        console.error(err);
        reply({ verdicts: Object.fromEntries(msg.candidates.map((c) => [c.hash, rulesVerdict(c)])), mode: "none" } satisfies ScanResult);
      });
      return true;
    case "engine-status":
      void status().then(reply);
      return true;
    case "engine-stats":
      void addStats(msg.delta).then(
        () => reply({ ok: true }),
        (err: Error) => reply({ ok: false, error: err.message }),
      );
      return true;
    default:
      return false;
  }
});
