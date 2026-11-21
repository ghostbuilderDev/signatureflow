import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
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
    version,
    commit,
    builtAt: new Date().toISOString(),
  }) + "\n",
);
