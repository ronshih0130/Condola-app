import { execFileSync } from "node:child_process";
import { join } from "node:path";

const script = join(process.cwd(), "scripts", "check-banned-terms.mjs");

/** Run the shared checker against rendered HTML. Throws with file:line hits. */
export function scanRenderedHtml(label: string, html: string) {
  try {
    execFileSync(process.execPath, [script, "--html-stdin", "--label", label], {
      input: html,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    const output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`.trim();
    throw new Error(output || `banned-term check failed for ${label}`);
  }
}
