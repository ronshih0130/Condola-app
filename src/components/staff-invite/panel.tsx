"use client";

import React, { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { staffInviteCopy } from "../../i18n/staff-invite";
import { inviteDate, staffInviteApiPath, staffInvitePath, type InviteOptions, type InviteScreen } from "../../lib/staff-invite";
import { inviteQrSvg } from "../../lib/staff-invite-qr";
import type { InviteBinding, StaffInviteData } from "../../server/b040-staff-ui";

export function StaffInvitePanel({ data, screen, origin, opts = {} }: {
  data: StaffInviteData; screen: InviteScreen; origin: string; opts?: InviteOptions;
}) {
  const c = staffInviteCopy(data.locale), text = c.text;
  const [bindings, setBindings] = useState(data.bindings);
  const [error, setError] = useState(false), [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(opts.notice === "saved" ? c.saved : opts.notice ? text(opts.notice) : "");
  // M4-Q (mockup shot-m4q-phone): the latest join is shown once, inside the QR card, as 「{name} 剛剛加入（n／4）」.
  const [joinedLine, setJoinedLine] = useState("");
  const base = staffInvitePath(data.unitId), api = staffInviteApiPath(data.unitId), tenants = `${base}/tenants`;
  const date = data.invite ? inviteDate(data.invite.expiresAt) : "";
  const url = data.invite ? `${origin}${data.invite.path}` : "", count = bindings.length;

  useEffect(() => {
    if (!data.invite || !["panel", "qr", "print"].includes(screen)) return;
    const invite = data.invite;
    let stopped = false, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let previous = new Set(data.bindings.map(b => b.id));
    const expire = () => { setInvalid(true); setError(true); };
    const expiry = setTimeout(expire, Math.max(0, Math.min(2147483647, Date.parse(invite.expiresAt) - Date.now())));
    const poll = async () => {
      if (stopped || controller) return;
      const started = Date.now();
      controller = new AbortController();
      const active = controller;
      const timeout = setTimeout(() => active.abort(), 2500);
      try {
        const response = await fetch(`${api}/live`, { credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer", signal: active.signal });
        if (!response.ok) throw new Error();
        const live = await response.json();
        if (stopped) return;
        if (live.fingerprint !== invite.fingerprint || !live.expiresAt || Date.parse(live.expiresAt) <= Date.now()) { expire(); return; }
        const rows: InviteBinding[] = live.bindings;
        const added = rows.filter(b => !previous.has(b.id));
        if (added.length && screen === "qr") setJoinedLine(staffInviteCopy(data.locale).text("joined", { name: added[added.length - 1].displayName, n: rows.length }));
        previous = new Set(rows.map(b => b.id));
        setBindings(rows); setInvalid(false); setError(false);
      } catch { if (!stopped) expire(); }
      finally { clearTimeout(timeout); controller = undefined; if (!stopped) timer = setTimeout(poll, Math.max(0, 3000 - (Date.now() - started))); }
    };
    const visible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void poll(); } };
    const pageShow = (event: PageTransitionEvent) => { if (event.persisted) location.reload(); };
    void poll();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pageshow", pageShow);
    return () => { stopped = true; controller?.abort(); clearTimeout(timer); clearTimeout(expiry); document.removeEventListener("visibilitychange", visible); window.removeEventListener("pageshow", pageShow); };
  }, [api, data.invite, data.bindings, data.locale, screen]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget), body = new URLSearchParams();
    form.forEach((value, key) => { if (typeof value === "string") body.append(key, value); });
    setBusy(true); setError(false);
    try {
      const response = await fetch(api, { method: "POST", body, credentials: "same-origin", referrerPolicy: "no-referrer", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error();
      const result = await response.json();
      location.assign(result.location);
    } catch { setError(true); setBusy(false); }
  }
  const link = (href: string, label: ReactNode, primary = false) => <a className={`si-button${primary ? " si-primary" : ""}`} href={href} rel="noreferrer">{label}</a>;
  const button = (label: string) => <button className="si-button si-primary" type="submit" disabled={busy}>{busy ? c.loading : label}</button>;
  const field = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const form = (action: string, children: ReactNode) => <form method="post" action={api} onSubmit={submit}>{field("action", action)}{children}</form>;
  const status = <div className="si-chips" aria-live="polite"><span className="si-chip" data-status>{text("status", { n: count })}</span>{data.invite && <span className="si-chip si-validity">{text("validity", { date })}</span>}</div>;
  const meta = (b: InviteBinding) => text(b.method, { name: b.displayName, date: b.joinedAtLabel ?? b.joinedAt });
  const qr = url && count < 4 && !invalid
    ? <div className="si-qr" data-qr dangerouslySetInnerHTML={{ __html: inviteQrSvg(url) }} />
    : <div className="si-qr si-unavailable" data-qr aria-disabled="true">{count >= 4 ? text("full") : c.error}</div>;
  const binding = bindings.find(b => b.id === opts.bindingId);
  const lease = data.leases.find(l => l.id === opts.leaseId);
  return <>
    <meta name="referrer" content="no-referrer" />
    <main className={`staff-invite si-${screen}`} data-screen={screen}>
      {error && <div className="alert bad"><p role="alert" data-error-message>{c.error}</p><button className="si-button" type="button" onClick={() => location.reload()}>{c.reload}</button></div>}
      {notice && <p className="alert good" role="status" data-notice>{notice}</p>}
      {screen === "panel" && <>
        <h1>{text("title", { place: data.place })}</h1>{status}
        {data.invite ? <>
          <p>{text("intro")}</p><h2>{text("nearby")}</h2>
          <a href={`${base}/qr`} className="si-show-qr" rel="noreferrer"><span className="si-mini-qr">{qr}</span><span className="si-button">{text("qr")}</span></a>
          <h2>{text("away")}</h2><div className="si-stack">
            {invalid ? <button className="si-button si-primary" disabled>{text("share")}</button> : link(`line://msg/text/${encodeURIComponent(text("message", { firm: data.firm, place: data.place, url, date }))}`, text("share"), true)}
            <button className="si-button" type="button" disabled={invalid} onClick={async () => { try { await navigator.clipboard.writeText(url); setNotice(text("copied")); } catch { setError(true); } }}>{text("copy")}</button>
            {link(`${base}/print`, text("printCard"))}
          </div><p className="si-muted">{text("rules", { date })}</p>
          <div className="si-masked"><p className="si-muted">{text("masked")}</p><code>{origin}/join/••••</code></div>
          <nav>{!invalid && link(data.invite.path, text("preview"))}{link(tenants, text("tenants"))}{link(`${base}/rotate`, text("rotate"))}</nav>
        </> : <p role="alert">{c.error}</p>}
      </>}
      {screen === "qr" && <>
        <h1>{text("scan")}</h1><p>{data.place}</p>
        <div className="si-chips" aria-live="polite"><span className="si-chip" data-status>{text("status", { n: count })}</span></div>{qr}
        {count >= 4 && <section data-full><h2>{text("full")}</h2><p>{text("fullHelp")}</p>{link(tenants, text("tenants"))}</section>}
        {joinedLine && <p className="si-joined" role="status" data-live-joined>{joinedLine}</p>}
        <p className="si-muted">{text("liveHelp")}</p>
        <div className="si-stack">{link(base, text("done"), true)}</div>
      </>}
      {screen === "print" && <>
        <h1>{text("cardTitle", { firm: data.firm })}</h1><p>{data.place}</p>{qr}
        <ol><li>{text("step1")}</li><li>{text("step2", { firm: data.firm })}</li><li>{text("step3")}</li></ol>
        <p className="si-muted">{text("finePrint", { date })}</p>
        <button type="button" className="si-button si-primary si-no-print" disabled={invalid} onClick={() => window.print()}>{text("print")}</button>
        <nav className="si-no-print">{link(base, text("back"))}</nav>
      </>}
      {screen === "rotate" && <><h1>{text("rotateTitle")}</h1><p>{text("rotateBody")}</p>{form("rotate", button(text("rotateConfirm")))}{link(base, text("cancel"))}</>}
      {screen === "tenants" && <>
        <h1>{data.place}</h1><h2>{text("bound", { n: count })}</h2>
        {count ? <ul className="si-rows">{bindings.map(b => <li key={b.id}><div><strong>{b.name}</strong><p className="si-muted">{meta(b)}</p></div>{link(`${base}/remove/${b.id}`, text("remove"))}</li>)}</ul> : <p>{text("empty")}</p>}
        <h2>{text("inviteRow")}</h2>{status}{link(base, text("invite"), true)}<nav>{link(`${base}/lease`, text("leaseLink"))}</nav>
      </>}
      {screen === "remove" && (binding ? <><h1>{text("removeTitle")}</h1><p>{text("removeBody", { name: binding.name })}</p>{form("remove", <>{field("bindingId", binding.id)}{button(text("remove"))}</>)}{link(tenants, text("cancel"))}</> : <p role="alert">{c.error}</p>)}
      {screen === "lease" && <>
        <h1>{text("leaseTitle")}</h1><p>{data.place}</p>
        {!count ? <><h2>{text("noBound")}</h2><p>{text("noBoundHelp")}</p>{link(base, text("invite"))}</> : !opts.leaseId ? <nav>{data.leases.map(l => <span key={l.id}>{link(`${base}/lease/${l.id}`, l.label)}</span>)}{link("/m/leases/new", text("leaseLink"))}</nav> : lease ? <>
          <p>{lease.label}</p><p>{text("leaseHelp")}</p>
          {form("include", <>{field("leaseId", lease.id)}<fieldset><legend className="sr-only">{text("leaseTitle")}</legend>{bindings.filter(b => b.pending).map(b => <label className="si-check" key={b.id}><input type="checkbox" name="bindingIds" value={b.id} /><span>{b.name}<small>{meta(b)}</small></span></label>)}</fieldset><p className="si-muted">{text("names")}</p>{button(text("save"))}</>)}
        </> : <p role="alert">{c.error}</p>}
        <nav>{link(tenants, text("skip"))}</nav>
      </>}
    </main>
  </>;
}
