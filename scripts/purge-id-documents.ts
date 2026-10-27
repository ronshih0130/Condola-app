import { runDueIdDocuments } from "../src/server/id-docs";

// Manual invocations obey the same DB mode; --dry-run cannot bypass OFF.
const result = await runDueIdDocuments(500, 40, process.argv.includes("--dry-run"));
if (!result.disabled) console.log(JSON.stringify(result));
