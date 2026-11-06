import { NextResponse } from "next/server";
import { hashVendorToken, vendorTokenAcceptable } from "../vendor-repair-rules";
import { readLineConfig } from "./config";
import { channelOn, lineTransaction, randomProof, type BrowserProof } from "./login-link";
import { rejectLine } from "./login-token";
import { body, browserProof, envGate, LINE_BROWSER_COOKIE, LINE_CSRF_COOKIE, lineCookie, lineResponse, privateHeaders } from "./login-routes";
import { vendorScopeOn } from "./vendor-scope";

/**
 * B-035 "continue in LINE" gate for the existing /v/[token] page. Read-only: env OFF performs no query,
 * and every strict platform/org/channel/job check mirrors createLineFlow so a shown entry can start a flow.
 */
export async function vendorLineEntryEnabled(token: string): Promise<boolean> {
 if (!readLineConfig().platformEnabled || !vendorTokenAcceptable(token)) return false;
 try {
  return await lineTransaction(async c => {
   const hash = hashVendorToken(token);
   const pinned = (await c.query<{ org_id: string }>("SELECT org_id FROM repair_vendor_jobs WHERE token_hash=$1", [hash])).rows[0];
   if (!pinned) return false;
   await channelOn(c, pinned.org_id, "vendor");
   await vendorScopeOn(c, hash, pinned.org_id);
   return true;
  });
 } catch { return false; }
}

/**
 * POST /v/liff: same-origin browser-proof issuance for a job entry. The raw job token is accepted only in the
 * JSON body, is never echoed, and nothing is written to the database; only the B-033 proof cookies are set.
 */
export const vendorEntryProofPOST = (request: Request) => lineResponse(async () => {
 envGate();
 const url = new URL(request.url);
 if (url.search) rejectLine(404, "not_found");
 const input = await body(request);
 if (Object.keys(input).some(key => key !== "jobToken") || !input.jobToken) rejectLine(400, "invalid_request");
 const site = request.headers.get("sec-fetch-site");
 if (request.headers.get("origin") !== url.origin || (site && !["same-origin", "none"].includes(site))) rejectLine(403, "csrf");
 if (!(await vendorLineEntryEnabled(input.jobToken))) rejectLine(404, "not_found");
 let proof: BrowserProof;
 try { proof = browserProof(request); } catch { proof = { browser: randomProof(), csrf: randomProof() }; }
 const res = NextResponse.json({ csrf: proof.csrf }, { headers: privateHeaders });
 lineCookie(res, LINE_BROWSER_COOKIE, proof.browser); lineCookie(res, LINE_CSRF_COOKIE, proof.csrf, false);
 return res;
});
