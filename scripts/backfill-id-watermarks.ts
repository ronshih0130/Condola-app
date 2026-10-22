import "../src/server/load-local-env";
import { backfillIdWatermarks } from "../src/server/id-docs";

const result = await backfillIdWatermarks();
console.log(`watermarked ${result.burned}, skipped ${result.failed}, scanned ${result.scanned}`);
