(async () => {
 const node = document.getElementById("line-bootstrap");
 if (!node || !window.liff) return;
 try {
  const config = JSON.parse(node.textContent);
  await window.liff.init({ liffId: config.liffId });
  const redirect = location.pathname + (config.flow ? "?flow=" + encodeURIComponent(config.flow) : config.orgId ? "?org=" + encodeURIComponent(config.orgId) : "");
  history.replaceState(null, "", redirect);
  if (!window.liff.isLoggedIn()) { window.liff.login({ redirectUri: location.origin + redirect }); return; }
  const post = async (path, value) => {
   const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
   if (!response.ok) throw new Error("authentication_required");
   return response.json();
  };
  const flow = config.flow || (await post("/api/line/flows", { purpose: "login", orgId: config.orgId, persona: config.persona, csrf: config.csrf })).flow;
  const result = await post("/api/line/session", { flow, idToken: window.liff.getIDToken(), csrf: config.csrf });
  if (result.next && /^\/(?!\/)/.test(result.next)) location.assign(result.next);
 } catch { /* Existing Email entry remains available; no tokens enter URLs/storage/logs. */ }
})();
