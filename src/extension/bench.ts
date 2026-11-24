import { SAMPLES, type Sample } from "../bench/samples.ts";
import { HELDOUT } from "../bench/heldout.ts";
import { pct, score, type Outcome } from "../bench/metrics.ts";
import { rulesVerdict, selectCandidates } from "../core/policy.ts";
import type { JudgeResult, Msg, Settings } from "../core/messages.ts";
import { onDeviceAvailability } from "./firebase.ts";

/**
 * Runs Untrap's full pipeline (rules, then Gemini Nano, then cloud Gemini when unsure, then the
 * "show me the order" check) on the benchmark set, on this computer, and scores it.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SETTINGS: Settings = { enabled: true, cloud: true, share: false, paused: [] };

interface Row extends Outcome {
  text: string;
  technique: string;
  rulesOnly: "attack" | "benign";
  secondOpinion: boolean;
  reason?: string;
}

let rows: Row[] = [];

// The tuning set was used to tune the rules and prompts; the held-out set never was.
const TUNING = { name: "tuning", samples: SAMPLES };
const HELD_OUT = { name: "heldout", samples: HELDOUT };
const currentSet = () => ($<HTMLSelectElement>("set").value === "heldout" ? HELD_OUT : TUNING);

async function runOne(s: Sample): Promise<Row> {
  const base = { id: s.id, expected: s.label, text: s.text, technique: s.technique };
  const [c] = await selectCandidates([{ id: s.id, text: s.text, technique: s.technique, hidden: s.hidden, where: "benchmark" }]);
  if (!c) return { ...base, predicted: "benign", decidedBy: "filtered", rulesOnly: "benign", secondOpinion: false, reason: "No signs worth checking" };
  const rulesOnly = rulesVerdict(c).verdict === "benign" ? "benign" : "attack";
  const r = (await chrome.runtime.sendMessage({ type: "bench-judge", candidate: c, settings: SETTINGS } satisfies Msg)) as JudgeResult & { error?: string };
  if (r.error) throw new Error(r.error);
  return {
    ...base,
    predicted: r.verdict.verdict === "benign" ? "benign" : "attack",
    decidedBy: r.verdict.source,
    ms: r.ms,
    rulesOnly,
    secondOpinion: r.secondOpinion,
    reason: r.verdict.reason,
  };
}

function renderRow(r: Row) {
  const tr = document.createElement("tr");
  const ok = r.expected === r.predicted;
  tr.className = ok ? "" : "miss";
  const cells = [
    r.id,
    r.expected,
    r.predicted,
    { filtered: "Rules (skipped)", on_device: "On-device", in_cloud: "Cloud", rules: "Rules" }[r.decidedBy] ?? r.decidedBy,
    r.secondOpinion ? "yes" : "",
    r.ms !== undefined ? `${(r.ms / 1000).toFixed(1)}s` : "",
    ok ? "✓" : "✗",
    r.text.length > 90 ? `${r.text.slice(0, 90)}…` : r.text,
  ];
  for (const v of cells) {
    const td = document.createElement("td");
    td.textContent = v;
    tr.appendChild(td);
  }
  $("rows").appendChild(tr);
}

function renderSummary() {
  const s = score(rows);
  const rules = score(rows.map((r) => ({ ...r, predicted: r.rulesOnly })));
  const cards: [string, string, string][] = [
    ["Attacks caught (recall)", pct(s.recall), `${s.tp} of ${s.tp + s.fn}`],
    ["Precision", pct(s.precision), `${s.fp} false alarm${s.fp === 1 ? "" : "s"}`],
    ["F1", s.f1.toFixed(3), `rules alone: ${rules.f1.toFixed(3)}`],
    ["False alarm rate", pct(s.falseAlarmRate), `${s.fp} of ${s.fp + s.tn} harmless`],
    ["AI decisions on-device", pct(s.onDeviceShare), "free and private"],
    ["Median time per check", `${(s.medianMs / 1000).toFixed(1)}s`, `${pct(s.skippedByRules)} needed no AI`],
  ];
  $("summary").replaceChildren(
    ...cards.map(([label, value, sub]) => {
      const d = document.createElement("div");
      d.innerHTML = "<span></span><b></b><small></small>";
      d.querySelector("span")!.textContent = label;
      d.querySelector("b")!.textContent = value;
      d.querySelector("small")!.textContent = sub;
      return d;
    }),
  );
}

$("run").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("run");
  button.disabled = true;
  rows = [];
  $("rows").replaceChildren();
  $("summary").replaceChildren();
  $<HTMLButtonElement>("download").disabled = true;
  const started = Date.now();
  const set = currentSet().samples;
  for (const [i, s] of set.entries()) {
    $("progress").textContent = `Checking ${i + 1} of ${set.length}…`;
    try {
      rows.push(await runOne(s));
    } catch (err) {
      rows.push({ id: s.id, expected: s.label, predicted: "benign", decidedBy: "error", text: s.text, technique: s.technique, rulesOnly: "benign", secondOpinion: false, reason: (err as Error).message });
    }
    renderRow(rows.at(-1)!);
    renderSummary();
  }
  $("progress").textContent = `Done: ${set.length} samples in ${Math.round((Date.now() - started) / 1000)}s.`;
  button.disabled = false;
  $<HTMLButtonElement>("download").disabled = false;
});

$("download").addEventListener("click", () => {
  const s = score(rows);
  const rules = score(rows.map((r) => ({ ...r, predicted: r.rulesOnly })));
  const report = { date: new Date().toISOString(), set: currentSet().name, chrome: navigator.userAgent, samples: rows.length, untrap: s, rulesOnly: rules, rows };
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `untrap-benchmark-${currentSet().name}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

void onDeviceAvailability().then((state) => {
  $("device").textContent = state === "available" ? "Gemini Nano is ready: first checks run on this device." : "Gemini Nano isn't available: first checks run in the cloud.";
});
function showCount() {
  const set = currentSet().samples;
  $("count").textContent = `${set.filter((s) => s.label === "attack").length} attacks and ${set.filter((s) => s.label === "benign").length} harmless samples`;
}
$("set").addEventListener("change", () => {
  rows = [];
  $("rows").replaceChildren();
  $("summary").replaceChildren();
  $<HTMLButtonElement>("download").disabled = true;
  $("progress").textContent = "";
  showCount();
});
showCount();
