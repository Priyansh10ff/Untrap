// Zips dist/extension into untrap-extension.zip for a GitHub release or the Devpost upload.
// Uses the system zip (macOS/Linux) or PowerShell's Compress-Archive (Windows).
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = join(root, "dist/extension");
const out = join(root, "untrap-extension.zip");
if (!existsSync(join(src, "manifest.json"))) {
  console.error("Run `npm run build` first.");
  process.exit(1);
}
// Never ship a secret: stop if dist/ contains one (for example the App Check debug token).
try {
  execFileSync(process.execPath, [join(root, "scripts/check-secrets.mjs"), "--release"], { stdio: "inherit" });
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
