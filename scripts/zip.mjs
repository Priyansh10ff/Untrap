// Zips dist/extension.
//   npm run zip           untrap-extension.zip, for the GitHub release. Refuses if dist/ contains
//                         any secret, so build it with `npm run build` (the public build).
//   npm run zip:private   untrap-extension-PRIVATE.zip from `npm run build:private`, for the
//                         judges only. It contains the App Check debug token: share it privately
//                         and never attach it to a public release.
// Uses the system zip (macOS/Linux) or PowerShell's Compress-Archive (Windows).
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "dist/extension");
const privateZip = process.argv.includes("--private");
const out = join(root, privateZip ? "untrap-extension-PRIVATE.zip" : "untrap-extension.zip");
if (!existsSync(join(src, "manifest.json"))) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}
// Never ship a secret: stop if dist/ contains one (for example the App Check debug token).
try {
  execFileSync(process.execPath, [join(root, "scripts/check-secrets.mjs"), "--release", ...(privateZip ? ["--allow-debug-token"] : [])], { stdio: "inherit" });
} catch {
  console.error("Not zipping: fix the secret check above first.");
  process.exit(1);
}
rmSync(out, { force: true });
if (process.platform === "win32") {
  execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -Path '${src}\\*' -DestinationPath '${out}'`], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-qr", out, "."], { cwd: src, stdio: "inherit" });
}
console.log(`Wrote ${out}`);
if (privateZip) console.warn("This zip contains your App Check debug token. Share it only with the judges, and revoke the token in the Firebase console after judging.");
