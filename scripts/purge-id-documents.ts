import { purgeDueIdDocuments } from "../src/server/id-docs";

const removed = await purgeDueIdDocuments();
console.log(`Purged ${removed} identity document${removed === 1 ? "" : "s"}.`);
