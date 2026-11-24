// Checks the site's security headers don't break anything. Serves dist/site with the headers
// from firebase.json, loads the built extension, and checks: no Content-Security-Policy
// violations on the landing page or the Attack Lab, Untrap's content script runs, and the X-ray
// panel renders under the policy. Needs `npm run build` first and Playwright.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright isn't installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(1);
}
const root = join(import.meta.dirname, "..");
const site = join(root, "dist/site"), ext = join(root, "dist/extension");
const headers = Object.fromEntries(JSON.parse(readFileSync(join(root, "firebase.json"), "utf8")).hosting.headers[0].headers.map((h) => [h.key, h.value]));
// Served over plain http here, so drop the https upgrade.
headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace("; upgrade-insecure-requests", "");
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let f = join(site, p);
  if (existsSync(f) && statSync(f).isDirectory()) f = join(f, "index.html");
  if (!existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { ...headers, "content-type": types[extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "ut-")), { headless: true, channel: "chromium", args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
let fail = 0;
for (const path of ["/", "/lab/"]) {
  const page = await ctx.newPage();
  const violations = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text().slice(0, 200)); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.log(`Refused to (event) ${e.violatedDirective} ${e.blockedURI}`)));
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const untrap = await page.evaluate(() => document.documentElement.getAttribute("data-untrap"));
  let xray = "n/a";
  if (path === "/lab/") {
    const id = await sw.evaluate(async (u) => Math.max(...(await chrome.tabs.query({})).map((t) => t.id)), base + path);
    await sw.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: "xray", on: true }), id);
    await page.waitForTimeout(800);
    xray = await page.evaluate(() => {
      const host = document.querySelector("[data-untrap-ui][id]");
      const r = host?.shadowRoot;
      if (!r) return "no host";
      const panel = r.querySelector(".panel");
      if (!panel) return "no panel";
      const cs = getComputedStyle(panel);
      return `panel position=${cs.position} bg=${cs.backgroundColor} items=${r.querySelectorAll(".list li").length}`;
    });
  }
  console.log(`${path}  untrap: ${untrap ?? "(not on this page)"}  x-ray: ${xray}  CSP violations: ${violations.length ? violations.join(" | ") : "none"}`);
  if (violations.length) fail++;
  if (path === "/lab/" && (!untrap || !xray.startsWith("panel"))) fail++;
}
await ctx.close(); server.close();
console.log(fail ? "FAILED" : "Security headers OK.");
process.exit(fail ? 1 : 0);
