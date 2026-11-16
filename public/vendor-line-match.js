/* VEN-31: no provider SDK, outbound messages, storage or caller-controlled navigation. */
(() => {
 const config = JSON.parse(document.getElementById("match-bootstrap").textContent);
 let busy = false;
 const review = document.getElementById("match-review"), error = document.getElementById("match-error");
 async function act(action, jobId) {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll("button")]; buttons.forEach(b => { b.disabled = true; });
  try {
   const response = await fetch("/v/link", { method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, csrf: config.csrf, ...(jobId ? { jobId } : {}) }) });
   if (!response.ok) throw new Error("unavailable");
   const result = await response.json();
   if (action === "remove") {
    const row = document.querySelector(`[data-job="${jobId}"]`), toast = document.getElementById("match-toast");
    toast.textContent = toast.dataset.template.replace("{工單}", row.querySelector("span").textContent);
    const ids = new Set(result.jobs.map(j => j.id));
    document.querySelectorAll("[data-job]").forEach(r => { if (!ids.has(r.dataset.job)) r.remove(); });
   } else if (["/vendor-account", "/consent?next=%2Fvendor-account"].includes(result.next) || /^\/v\/liff\?flow=[\w-]{43}$/.test(result.next)) {
    location.assign(result.next);
   } else throw new Error("unavailable");
  } catch { review.hidden = true; error.hidden = false; }
  finally { busy = false; buttons.forEach(b => { b.disabled = false; }); }
 }
 document.querySelectorAll("[data-remove]").forEach(b => { b.onclick = () => act("remove", b.dataset.remove); });
 document.getElementById("match-confirm").onclick = () => act("confirm");
 document.getElementById("match-retry").onclick = () => act("retry");
})();
