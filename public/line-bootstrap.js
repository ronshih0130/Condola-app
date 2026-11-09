/* Host-provided LIFF adapter only. No SDK download, provider HTTP, analytics, token storage or token URLs.
 * The server-rendered config.persona selects that portal's reviewed flow: tenant (B-034), vendor (B-035)
 * or owner (B-036). An unknown persona does nothing, leaving the existing Email entry. */
(async function () {
  const node = document.getElementById("line-bootstrap");
  if (!node) return;
  let config;
  try { config = JSON.parse(node.textContent); } catch { return; }
  // LINE Login v2.1 WEB OAuth fallback used whenever the host did not inject a LIFF SDK.
  function startOAuth(flow) { location.assign("/api/line/login/start?flow=" + encodeURIComponent(flow)); }
  if (config.persona === "tenant" || (config.persona === "owner" && config.purpose === "invite")) await tenant(config);
  else if (config.persona === "vendor") await vendor(config);
  else if (config.persona === "owner") await owner(config);

  async function tenant(config) {
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
    if (!liff) {
      // No LIFF SDK: drive the LINE Login v2.1 WEB OAuth redirect instead.
      if ((config.purpose === "invite" || config.purpose === "bind") && config.verified) {
        // The OAuth callback already verified the LINE identity; bind without an id_token.
        form.onsubmit = event => {
          event.preventDefault();
          return once(async () => {
            if (!form.elements.consent.checked) return;
            const result = await post(config.purpose === "invite" ? "/api/line/invites/accept" : "/api/line/bind", {
              flow: config.flow, password: form.elements.password.value,
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
      if (config.flow) { startOAuth(config.flow); return; }
      if (config.purpose === "login") {
        try {
          const flow = (await post("/api/line/flows", { purpose: "login", orgId: config.orgId, persona: config.persona })).flow;
          startOAuth(flow);
        } catch {
          showError();
        }
        return;
      }
      showError();
      return;
    }
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
  }

  async function vendor(config) {
    // Exactly the landings /api/line/session can return for a vendor flow: job claim, return path
    // (/vendor-account or /v/liff), or the vendor consent entry wrapping either return path.
    const landings = ["/v/liff/job", "/vendor-account", "/v/liff", "/consent?next=%2Fvendor-account", "/consent?next=%2Fv%2Fliff"];
    if (!window.liff) {
      // No LIFF SDK: start the WEB OAuth redirect from an existing or freshly minted login flow.
      try {
        if (config.flow) { if (!config.verified) startOAuth(config.flow); return; }
        if (config.orgId) {
          const response = await fetch("/api/line/flows", { method: "POST", credentials: "same-origin", cache: "no-store",
            headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "login", orgId: config.orgId, persona: config.persona, csrf: config.csrf }) });
          if (response.ok) { const flow = (await response.json()).flow; if (flow) startOAuth(flow); }
        }
      } catch { /* Existing Email entry remains available; no tokens enter URLs/storage/logs. */ }
      return;
    }
    try {
      await window.liff.init({ liffId: config.liffId });
      // SDK redirect processing must finish before the URL is normalized to the opaque flow/org hint.
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
      if (landings.includes(result.next)) location.assign(result.next);
    } catch { /* Existing Email entry remains available; no tokens enter URLs/storage/logs. */ }
  }

  async function owner(config) {
    try {
      const post = async function (path, body) {
        const response = await fetch(path, { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!response.ok) return null;
        return response.json();
      };
      const navigate = function (result) {
        if (result && typeof result.next === "string" &&
            (/^\/(t|o\/statements|vendor-account)$/.test(result.next) ||
             /^\/consent(?:\/portal)?\?next=%2F(?:t|o%2Fstatements|vendor-account)$/.test(result.next))) {
          location.assign(result.next);
        }
      };
      const buttons = document.querySelectorAll ? document.querySelectorAll("[data-line-portal]") : [];
      for (const button of buttons) button.addEventListener("click", async function () {
        button.disabled = true;
        try {
          navigate(await post("/api/line/portal", { orgId: button.dataset.lineOrg, persona: button.dataset.linePortal, csrf: config.csrf }));
        } catch {
          // Keep the existing Email entry available after cookie/network failure.
        } finally { button.disabled = false; }
      });
      // An existing account can select its portal without another SDK login.
      if (buttons.length) return;
      if (!window.liff) {
        // No LIFF SDK: owner login via the WEB OAuth redirect.
        if (config.flow) { if (!config.verified) startOAuth(config.flow); return; }
        if (config.orgId) {
          const flow = await post("/api/line/flows", { purpose: "login", orgId: config.orgId, persona: config.persona, csrf: config.csrf });
          if (flow && flow.flow) startOAuth(flow.flow);
        }
        return;
      }
      await window.liff.init({ liffId: config.liffId });
      const entry = location.pathname + (config.flow ? "?flow=" + encodeURIComponent(config.flow) : "");
      history.replaceState(null, "", entry);
      if (!window.liff.isLoggedIn()) {
        window.liff.login({ redirectUri: location.origin + entry });
        return;
      }
      const flow = config.flow ? { flow: config.flow } : await post("/api/line/flows", {
        purpose: "login", orgId: config.orgId, persona: config.persona, csrf: config.csrf
      });
      if (!flow) return;
      const result = await post("/api/line/session", { flow: flow.flow, idToken: window.liff.getIDToken(), csrf: config.csrf });
      // Server and client allowlists apply; never copy tokens to navigation or storage.
      navigate(result);
    } catch {
      // Existing Email entry remains available after SDK/cookie failures.
    }
  }
})();
