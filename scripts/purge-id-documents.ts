import { previewDueIdDocuments, purgeDueIdDocumentsUntilDone } from "../src/server/id-docs";

const result = process.argv.includes("--dry-run")
  ? await previewDueIdDocuments(500, 40)
  : { removed: await purgeDueIdDocumentsUntilDone(500, 40) };
console.log(JSON.stringify(result));
