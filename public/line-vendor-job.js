(() => {
 const form = document.getElementById("vendor-report");
 if (!form) return;
 form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = form.querySelector("button"); button.disabled = true;
  try {
   const data = new FormData(form);
   const csrf = document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith("condola_line_csrf="))?.split("=")[1];
   const response = await fetch("/api/line/vendor-job", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csrf, done: data.has("done") ? "true" : "false", cost: data.get("cost") }) });
   if (response.ok) location.reload();
   else if (response.status === 401 || response.status === 403) location.assign("/login");
   else document.getElementById("report-error").hidden = false;
  } catch { document.getElementById("report-error").hidden = false; }
  finally { button.disabled = false; }
 });
})();
