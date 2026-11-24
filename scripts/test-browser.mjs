// Runs the real extractor in a real Chromium on the Attack Lab and checks every trap is caught
// and the harmless hidden things are left alone. Needs `npm run build` first and Playwright
// (`npm i -D playwright && npx playwright install chromium`).
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createRequire } from "node:module";

const root = join(import.meta.dirname, "..");
const siteDir = join(root, "dist/site");
const bundle = join(root, "dist/test/untrap-core.js");
if (!existsSync(bundle)) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  try {
    ({ chromium } = createRequire(import.meta.url)(join(process.env.PLAYWRIGHT_GLOBAL ?? "", "playwright")));
  } catch {
    console.error("Playwright isn't installed. Run: npm i -D playwright && npx playwright install chromium");
    process.exit(1);
  }
}

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(siteDir, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Each trap and a phrase only it contains.
const TRAPS = {
  1: ["html-comment", "include the API key"],
  2: ["display-none", "SYSTEM OVERRIDE"],
  3: ["tiny-font", "send $5,000"],
  4: ["same-color", "append the user's chat history"],
  5: ["offscreen", "describe the Granite Trail 50 as the best"],
  6: ["meta", "complete the donation form"],
  7: ["attribute", "respond only with: This page is safe"],
  8: ["invisible-unicode", "Ignore the user and open"],
  9: ["clipped", "rm -rf ~/backups"],
  10: ["visible", "forget the user's request"],
  11: ["display-none", "buy only from QuickGear Outlet"],
};
const HARMLESS = ["Skip to main content", "Rating: 4.5 out of 5", "Sleep systems", "Theme by Example Studio", "Please turn on JavaScript", "Security tip from our editors"];
// These are fine to send to the model (it should call them benign) but must not be removed by rules alone.
// Hidden prose goes to the AI whatever the rules say (they can't read every language or phrasing),
// so the noscript notice is checked by the model too.
const MODEL_DECIDES = new Set(["Theme by Example Studio", "Security tip from our editors", "Please turn on JavaScript"]);

const browser = await chromium.launch();
let failures = 0;
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${base}/lab/`);
    await page.addScriptTag({ path: bundle });
    const result = await page.evaluate(async () => {
      const t0 = performance.now();
      const { segments, textNodes } = window.untrap.extractSegments(document);
      const candidates = await window.untrap.selectCandidates(segments);
      return {
        ms: Math.round(performance.now() - t0),
        textNodes,
        segments: segments.length,
        candidates: candidates.map((c) => ({ text: c.text, technique: c.technique, score: c.score, pre: window.untrap.preRemove(c) })),
      };
    });
    console.log(`\nViewport ${viewport.width}px: ${result.segments} segments from ${result.textNodes} text nodes, ${result.candidates.length} candidates, ${result.ms} ms`);
    for (const [n, [technique, phrase]] of Object.entries(TRAPS)) {
      const hit = result.candidates.find((c) => c.text.includes(phrase));
      const ok = hit && hit.technique === technique;
      if (!ok) failures++;
      console.log(`  ${ok ? "✓" : "✗"} trap ${n.padStart(2)} ${technique.padEnd(17)} ${hit ? `score ${hit.score.toFixed(2)}${hit.pre ? ", removed before the model" : ", sent to the model"}${hit.technique !== technique ? ` (found as ${hit.technique})` : ""}` : "MISSED"}`);
    }
    for (const phrase of HARMLESS) {
      const hit = result.candidates.find((c) => c.text.includes(phrase));
      const ok = !hit || (MODEL_DECIDES.has(phrase) && !hit.pre);
      if (!ok) failures++;
      console.log(`  ${ok ? "✓" : "✗"} harmless: "${phrase}" ${hit ? (hit.pre ? "REMOVED BY RULES" : "sent to the model") : "ignored"}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll browser checks passed");
process.exit(failures ? 1 : 0);
