/* Host-provided LIFF adapter only. No SDK download, token storage or provider transport. */
(async function () {
  const node = document.getElementById("line-bootstrap");
  if (!node) return;
  const config = JSON.parse(node.textContent);
  const liff = window.liff;
  const status = document.getElementById("line-status");
  const showError = () => { if (status) status.hidden = false; };
  async function post(path, body, method = "POST") {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, csrf: config.csrf }) });
    if (!response.ok) throw new Error("reauthenticate");
    return response.json();
  }
  async function confirmSession() {
    const response = await fetch("/api/line/links", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("cookie_unavailable");
  }
  function next(path) {
    // The server picks the landing route; guard navigation even against a malformed response.
    if (["/t", "/o/statements", "/vendor-account", "/t/liff", "/v/liff", "/o/liff", "/login", "/consent/portal?next=%2Ft", "/consent/portal?next=%2Fo%2Fstatements", "/consent?next=%2Fvendor-account"].includes(path)) location.assign(path);
    else showError();
  }
  async function verifyPassword(form) {
    return post("/api/line/reauth", { orgId: config.orgId, persona: config.persona,
      password: form.elements.password.value, secondFactor: form.elements.secondFactor.value });
  }
  const form = document.getElementById("line-confirm");
  let busy = false;
  async function once(work) {
    if (busy) return;
    busy = true;
    try { await work(); } catch { showError(); } finally { busy = false; }
  }
  // Recovery management remains usable without a LINE SDK or live provider availability.
  if (config.purpose === "manage") {
    for (const [id, global] of [["line-unlink", false], ["line-revoke", true]]) {
      const button = document.getElementById(id);
      if (button) button.onclick = () => once(async () => {
        await verifyPassword(form);
        const response = await fetch("/api/line/links", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("unavailable");
        const data = await response.json();
        const link = data.links.find(item => item.orgId === config.orgId && item.persona === config.persona && item.status === "linked");
        if (!link) throw new Error("unavailable");
        await post(global ? "/api/line/identity" : `/api/line/links/${encodeURIComponent(link.id)}`, global ? { identityId: link.identityId } : { reason: "user_request" }, "DELETE");
        next("/login");
      });
    }
  }
  if (!liff) { showError(); return; }
  try {
    await liff.init({ liffId: config.liffId });
    // SDK redirect processing must finish first. Strip every provider/query fragment afterward.
    history.replaceState(null, "", location.pathname);
    if (!liff.isLoggedIn() && config.purpose !== "manage") {
      const context = config.flow ? `flow=${encodeURIComponent(config.flow)}` : `org=${encodeURIComponent(config.orgId)}${config.purpose === "manage" ? "&mode=manage" : ""}`;
      liff.login({ redirectUri: `${location.origin}${location.pathname}?${context}` });
      return;
    }
    if (["invite", "bind", "manage"].includes(config.purpose)) {
      form.onsubmit = event => {
        event.preventDefault();
        return once(async () => {
          if (!form.elements.consent.checked) return;
          if (!liff.isLoggedIn()) {
            liff.login({ redirectUri: `${location.origin}${location.pathname}?org=${encodeURIComponent(config.orgId)}&mode=manage` });
            return;
          }
          let handle = config.flow;
          if (config.purpose === "manage") {
            await verifyPassword(form);
            const flow = await post("/api/line/flows", { purpose: "bind", orgId: config.orgId, contactId: config.contactId, persona: config.persona });
            handle = flow.flow;
          }
          const result = await post(config.purpose === "invite" ? "/api/line/invites/accept" : "/api/line/bind", {
            flow: handle, idToken: liff.getIDToken(), password: form.elements.password.value,
            secondFactor: form.elements.secondFactor.value, consentTextKey: "line.binding.v1",
          });
          form.elements.password.value = "";
          form.elements.secondFactor.value = "";
          await confirmSession();
          next(result.next || (config.persona === "tenant" ? "/t" : config.persona === "owner" ? "/o/statements" : "/vendor-account"));
        });
      };
      const submit = document.getElementById("line-submit");
      if (submit) submit.disabled = false;
      return;
    }
    let flow = config.flow;
    if (!flow) flow = (await post("/api/line/flows", { purpose: "login", orgId: config.orgId, persona: config.persona })).flow;
    const result = await post("/api/line/session", { flow, idToken: liff.getIDToken() });
    if (result.next) await confirmSession();
    next(result.next || "/login");
  } catch { showError(); }
})();
