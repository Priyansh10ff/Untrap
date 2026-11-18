// Builds the Chrome extension (dist/extension), the website (dist/site) and a test bundle.
// Firebase settings come from .env (copy .env.example). Without them the extension still
// builds and runs on rules only.
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const env = { ...readEnv(join(root, ".env")), ...process.env };

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const firebase = env.FIREBASE_API_KEY
  ? {
      apiKey: env.FIREBASE_API_KEY,
      authDomain: env.FIREBASE_AUTH_DOMAIN,
      projectId: env.FIREBASE_PROJECT_ID,
      storageBucket: env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID,
      appId: env.FIREBASE_APP_ID,
    }
  : null;
const siteUrl = (env.SITE_URL || (firebase ? `https://${firebase.projectId}.web.app` : "http://localhost:5050")).replace(/\/$/, "");

const define = {
  __FIREBASE_CONFIG__: JSON.stringify(firebase),
  __APPCHECK_DEBUG_TOKEN__: JSON.stringify(env.APPCHECK_DEBUG_TOKEN || ""),
  __RECAPTCHA_SITE_KEY__: JSON.stringify(env.RECAPTCHA_ENTERPRISE_SITE_KEY || ""),
  __FIRST_PASS_CLOUD_MODEL__: JSON.stringify(env.FIRST_PASS_CLOUD_MODEL || "gemini-3.5-flash-lite"),
  __SECOND_OPINION_MODEL__: JSON.stringify(env.SECOND_OPINION_MODEL || "gemini-3.5-flash-lite"),
  __SITE_URL__: JSON.stringify(siteUrl),
};

const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, target: "chrome138", define, logLevel: "info", legalComments: "none", minify: !watch, sourcemap: watch ? "inline" : false };

const ext = join(dist, "extension");
cpSync(join(root, "src/extension/static"), ext, { recursive: true });
const site = join(dist, "site");
cpSync(join(root, "src/site/static"), site, { recursive: true });

const builds = [
  { ...common, entryPoints: { background: "src/extension/background.ts", offscreen: "src/extension/offscreen.ts", popup: "src/extension/popup.ts", welcome: "src/extension/welcome.ts", bench: "src/extension/bench.ts" }, outdir: ext, format: "esm" },
  // Content scripts can't be modules.
  { ...common, entryPoints: { content: "src/extension/content.ts" }, outdir: ext, format: "iife" },
  { ...common, entryPoints: { "assets/site": "src/site/site.ts" }, outdir: site, format: "esm", target: "es2022" },
  // Lets the browser tests run the real extractor on a real page.
  { ...common, minify: false, entryPoints: { "untrap-core": "test/browser-entry.ts" }, outdir: join(dist, "test"), format: "iife", globalName: "untrap" },
].map((b) => ({ ...b, absWorkingDir: root }));

if (watch) {
  for (const b of builds) await (await context(b)).watch();
  console.log("Watching for changes…");
} else {
  await Promise.all(builds.map((b) => build(b)));
  console.log(`\nBuilt dist/extension and dist/site. Firebase: ${firebase ? firebase.projectId : "not configured (rules only)"}. App Check debug token: ${env.APPCHECK_DEBUG_TOKEN ? "set" : "not set"}.`);
}
