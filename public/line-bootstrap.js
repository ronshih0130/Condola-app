/* Local adapter boundary: no CDN, provider HTTP, analytics, or token persistence.
 * The host may supply the reviewed LIFF SDK as window.liff. No SDK is downloaded here. */
(async () => {
  const node = document.getElementById("line-bootstrap");
  if (!node || !window.liff) return;
  const config = JSON.parse(node.textContent);
  try {
    await window.liff.init({ liffId: config.liffId });
    // SDK redirect processing must finish before removing callback parameters.
    history.replaceState(null, "", location.pathname);
    if (!window.liff.isLoggedIn()) {
      const context = config.flow ? "flow=" + encodeURIComponent(config.flow) : "org=" + encodeURIComponent(config.orgId);
      window.liff.login({ redirectUri: location.origin + location.pathname + "?" + context });
      return;
    }
    const post = async (path, payload) => {
      const response = await fetch(path, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, csrf: config.csrf }) });
      if (!response.ok) throw new Error("line_entry_unavailable");
      return response.json();
    };
    const flow = config.flow || (await post("/api/line/flows", { purpose: "login", orgId: config.orgId, persona: config.persona })).flow;
    const result = await post("/api/line/session", { flow, idToken: window.liff.getIDToken() });
    if (result.next) location.assign(result.next);
    // account_required leaves the existing Email sign-in entry available.
  } catch { /* Keep the existing Email entry; no token/error logging. */ }
})();
