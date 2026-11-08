import { createHash } from "node:crypto";

// Standalone document: no app shell, analytics, third-party resources or React
// hydration can observe the fragment. Scrub history before parsing or awaiting.
export const unitQrExchangeScript = `(async()=>{
  const fragment=location.hash;
  history.replaceState(null,"",location.pathname);
  try {
    const token=new URLSearchParams(fragment.slice(1)).get("t");
    if(!token) throw new Error();
    const response=await fetch("/api/signup/unit-qr",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token}),credentials:"same-origin",cache:"no-store",referrerPolicy:"no-referrer"});
    location.replace(response.ok?"/signup":"/signup?error=required");
  } catch { location.replace("/signup?error=required"); }
})();`;

export const unitQrPrivateHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
export function unitQrEntryResponse() {
  const hash = createHash("sha256").update(unitQrExchangeScript).digest("base64");
  return new Response(`<!doctype html><html><head><meta name="referrer" content="no-referrer"><script>${unitQrExchangeScript}</script></head><body></body></html>`, {
    headers: {
      ...unitQrPrivateHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
