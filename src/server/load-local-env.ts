import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fill unset process env from the gitignored .env. A value already in the
 * environment stays. Integration tests import this before anything that encrypts.
 */
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
let text = "";
try {
  text = readFileSync(file, "utf8");
} catch {
  text = "";
}
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 1) continue;
  const key = trimmed.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  if (process.env[key]) continue;
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  process.env[key] = value;
}
