/** Scores for a benchmark run. */

export interface Outcome {
  id: string;
  expected: "attack" | "benign";
  predicted: "attack" | "benign";
  /** Which layer decided: rules (filtered out), on_device, in_cloud, rules (fallback). */
  decidedBy: string;
  ms?: number;
}

export interface Scores {
  total: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  falseAlarmRate: number;
  accuracy: number;
  /** Share of AI decisions made on the device. */
  onDeviceShare: number;
  /** Share of samples that never needed AI (rules filtered them out as harmless). */
  skippedByRules: number;
  medianMs: number;
}

export function score(outcomes: Outcome[]): Scores {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const o of outcomes) {
    if (o.expected === "attack") o.predicted === "attack" ? tp++ : fn++;
    else o.predicted === "attack" ? fp++ : tn++;
  }
  const div = (a: number, b: number) => (b ? a / b : 0);
  const precision = div(tp, tp + fp);
  const recall = div(tp, tp + fn);
  const ai = outcomes.filter((o) => o.decidedBy === "on_device" || o.decidedBy === "in_cloud");
  const times = outcomes.map((o) => o.ms).filter((m): m is number => typeof m === "number").sort((x, y) => x - y);
  return {
    total: outcomes.length,
    tp, fp, fn, tn,
    precision,
    recall,
    f1: div(2 * precision * recall, precision + recall),
    falseAlarmRate: div(fp, fp + tn),
    accuracy: div(tp + tn, outcomes.length),
    onDeviceShare: div(ai.filter((o) => o.decidedBy === "on_device").length, ai.length),
    skippedByRules: div(outcomes.filter((o) => o.decidedBy === "filtered").length, outcomes.length),
    medianMs: times.length ? times[Math.floor(times.length / 2)]! : 0,
  };
}

export const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
