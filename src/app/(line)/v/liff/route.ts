import { createLiffBootstrap } from "@/server/line/bootstrap";
import { vendorEntryProofPOST } from "@/server/line/vendor-entry";

export const GET = createLiffBootstrap("vendor");
export const POST = vendorEntryProofPOST;
