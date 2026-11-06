(async function () {
  const element = document.getElementById("line-bootstrap");
  if (!element) return;
  try {
    const config = JSON.parse(element.textContent);
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
    if (buttons.length || !window.liff) return;
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
})();
