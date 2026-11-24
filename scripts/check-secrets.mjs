// Fails if a secret could leak.
//
//   node scripts/check-secrets.mjs            checks the files git tracks (run before you push)
//   node scripts/check-secrets.mjs --release  also checks dist/, which is what gets zipped and shipped
//
// It looks for two things: the actual values of secrets in your .env (anything named *TOKEN*,
// *SECRET*, *PASSWORD* or *PRIVATE*), and well-known secret formats (private keys, GitHub and
// OpenAI-style tokens, service-account JSON). It never prints a secret, only where it was found.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const release = process.argv.includes("--release");

function readEnv() {
  const file = join(root, ".env");
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = readEnv();
const secretValues = Object.entries(env)
  .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|PRIVATE/.test(key) && value.length >= 8)
  .map(([key, value]) => ({ name: `the value of ${key} from .env`, test: (text) => text.includes(value) }));

const PATTERNS = [
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a service-account key", /"private_key"\s*:\s*"-----BEGIN/],
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["an OpenAI or Anthropic key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{30,}/],
  ["a Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}/],
];
// A Firebase web API key is public by design (it ships inside every Firebase web app), so it is
// allowed in dist/. It still doesn't belong in source files: those read it from .env.
const API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/;

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch {
    return walk(root).filter((f) => !/^(node_modules|dist|\.git)\//.test(f));
  }
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "node_modules" && name !== ".git") out.push(...walk(full));
    } else out.push(relative(root, full).replaceAll("\\", "/"));
  }
  return out;
}

const problems = [];

function scan(file, { allowApiKey }) {
  const full = join(root, file);
  if (!existsSync(full) || statSync(full).size > 5_000_000) return;
  const text = readFileSync(full, "latin1");
  for (const s of secretValues) if (s.test(text)) problems.push(`${file}: contains ${s.name}`);
  for (const [name, re] of PATTERNS) if (re.test(text)) problems.push(`${file}: looks like it contains ${name}`);
  if (!allowApiKey && API_KEY.test(text)) problems.push(`${file}: contains a Firebase/Google API key (read it from .env instead)`);
}

const tracked = trackedFiles();
for (const f of tracked) {
  if (/(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}: an .env file is tracked by git`);
  scan(f, { allowApiKey: false });
}

if (release) {
  for (const dir of ["dist/extension", "dist/site"]) {
    if (!existsSync(join(root, dir))) continue;
    for (const f of walk(join(root, dir))) scan(f, { allowApiKey: true });
  }
}

if (problems.length) {
  console.error(`Secret check failed (${release ? "source and release files" : "source files"}):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("Nothing was printed from the secret itself. Remove it, and rotate it if it was ever pushed or shared.");
  process.exit(1);
}
console.log(`Secret check passed: ${tracked.length} tracked files${release ? " and dist/" : ""}, ${secretValues.length} .env secret(s) checked.`);
