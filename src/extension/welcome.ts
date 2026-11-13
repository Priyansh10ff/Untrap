import { DEFAULT_SETTINGS, type Settings } from "../core/messages.ts";
import { getModels, onDeviceAvailability } from "./firebase.ts";

declare const __SITE_URL__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings = DEFAULT_SETTINGS;

async function load() {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
  $<HTMLInputElement>("cloud").checked = settings.cloud;
  $<HTMLInputElement>("share").checked = settings.share;
  $("paused").textContent = settings.paused.length ? settings.paused.join(", ") : "None";
  $<HTMLAnchorElement>("lab-link").href = `${__SITE_URL__}/lab/`;
}

async function save(next: Partial<Settings>) {
  settings = { ...settings, ...next };
  await chrome.storage.local.set({ settings });
  await load();
}

async function renderModel() {
  const pill = $("model-pill");
  const button = $<HTMLButtonElement>("download");
  const note = $("model-note");
  const state = await onDeviceAvailability();
  button.hidden = true;
  note.textContent = "";
  if (state === "available") {
    pill.textContent = "Gemini Nano is ready";
    pill.className = "pill ok";
  } else if (state === "downloadable") {
    pill.textContent = "Not downloaded yet";
    pill.className = "pill warn";
    button.hidden = false;
  } else if (state === "downloading") {
    pill.textContent = "Downloading…";
    pill.className = "pill warn";
    button.hidden = false;
    button.textContent = "Show progress";
  } else {
    pill.textContent = "Not available on this computer";
    pill.className = "pill";
    note.textContent =
      state === "unsupported"
        ? "This version of Chrome doesn't have the built-in model. Untrap uses cloud AI instead (if turned on below)."
        : "This computer doesn't meet Gemini Nano's requirements (desktop Chrome, 22 GB free space, a GPU with 4 GB+ or 16 GB RAM). Untrap uses cloud AI instead.";
  }
}

$("download").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("download");
  const progress = $("progress");
  const bar = $("progress-bar");
  const models = getModels();
  button.disabled = true;
  progress.style.display = "block";
  try {
    // Firebase AI Logic starts the download. It needs this click (Chrome requires a user gesture).
    if (models) {
      // Starts the download and returns; progress arrives through the callback.
      await models.hybrid.initializeDeviceModel((p) => (bar.style.width = `${Math.round(p * 100)}%`));
      await waitUntilReady();
    } else {
      // Firebase not configured in this build: ask Chrome directly so the model is ready later.
      const lm = (globalThis as unknown as { LanguageModel: { create(o: unknown): Promise<{ destroy(): void }> } }).LanguageModel;
      const session = await lm.create({
        expectedInputs: [{ type: "text", languages: ["en"] }],
        expectedOutputs: [{ type: "text", languages: ["en"] }],
        monitor(m: EventTarget) {
          m.addEventListener("downloadprogress", (e) => (bar.style.width = `${Math.round((e as ProgressEvent).loaded * 100)}%`));
        },
      });
      session.destroy();
    }
    bar.style.width = "100%";
  } catch (err) {
    $("model-note").textContent = `Download didn't start: ${(err as Error).message}`;
  } finally {
    button.disabled = false;
    await renderModel();
  }
});

async function waitUntilReady() {
  for (let i = 0; i < 1800; i++) {
    const state = await onDeviceAvailability();
    if (state === "available" || state === "unavailable" || state === "unsupported") return;
    $("model-pill").textContent = "Downloading…";
    await new Promise((r) => setTimeout(r, 2000));
  }
}

$("cloud").addEventListener("change", (e) => void save({ cloud: (e.target as HTMLInputElement).checked }));
$("share").addEventListener("change", (e) => void save({ share: (e.target as HTMLInputElement).checked }));
$("clear-paused").addEventListener("click", () => void save({ paused: [] }));

void load();
void renderModel();
