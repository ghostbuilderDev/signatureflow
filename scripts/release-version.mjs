import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
let commit = process.env.GITHUB_SHA || "local";
if (commit === "local") {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
}
await writeFile(
  "dist/version.json",
  JSON.stringify({
    version: "2.1.0",
    commit,
    builtAt: new Date().toISOString(),
  }) + "\n",
);
