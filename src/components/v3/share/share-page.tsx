import React, { type CSSProperties } from "react";
import type { Locale } from "../../../i18n";
import { caseShareCopy } from "../../../i18n/lanes/brand-v3-case-share";
import type { ShareView } from "../../../server/b110-case-share";
import { Illustration } from "../illustrations";
import baseTokens from "../../../brand/v2/tokens.json";
import brandTokens from "../../../brand/v3/tokens.json";

// A bearer page has no session org in RootLayout: scope the canonical tokens here (as the V-TOKEN shell does).
const tokens = Object.fromEntries(
  [baseTokens.color, baseTokens.font, baseTokens.size, baseTokens.space, baseTokens.radius, baseTokens.shadow, baseTokens.layout,
    brandTokens.color, brandTokens.radius].flatMap(group => Object.entries(group).map(([key, entry]) => [`--${key}`, entry.value])),
) as CSSProperties;

function money(currency: string, minor: string) {
  const grouped = minor.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return currency === "TWD" ? `NT$${grouped}` : `${currency} ${grouped}`;
}

/**
 * B-110 唯讀分享頁 (OWN-32, MGT-124-AC2) and its expired / revoked states (share-expired; OWN-32-AC3). No buttons,
 * no sign-in, no other case. Documents keep their nature mark; voided ones are last, muted and struck. Tapping a
 * document opens its PDF; photos are the staff-approved 處理後 photos only. No buyer, tenant or owner details.
 */
export function SharePage({ locale, token, view }: { locale: Locale; token: string; view: ShareView }) {
  const copy = caseShareCopy(locale);
  const base = `/s/${encodeURIComponent(token)}`;
  return <div className="v-token-v3 v-share" data-testid="case-share" style={tokens}>
    {/* eslint-disable-next-line @next/next/no-css-tags -- bearer-only stylesheets, scoped to this page */}
    <link rel="stylesheet" href="/brand/v3/vendor-token.css" />
    {/* eslint-disable-next-line @next/next/no-css-tags */}
    <link rel="stylesheet" href="/brand/v3/case-share.css" />
    <header className="v-token-bar"><div><strong>{copy.brand}</strong><p>{copy.sharedBy.replace("{company}", view.company)}</p></div></header>
    <main className="v-token-main">
      {view.state === "ok" ? <>
        <div className="v-token-lead"><h1>{view.title}</h1></div>
        <section className="v-token-card v-share-card">
          <dl>
            {view.status !== "cancelled" ? <div><dt>{copy.status}</dt><dd>{view.status === "closed" ? copy.done : copy.working}</dd></div> : null}
            {view.vendor ? <div><dt>{copy.vendor}</dt><dd>{view.vendor}</dd></div> : null}
          </dl>
          {view.photos.length ? <>
            <h2 className="v-share-h">{copy.photos}</h2>
            <ul className="v-share-tiles">{view.photos.map(photo => <li key={photo.id}>
              {/* Private photo bytes, re-admitted by the share route on every request. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${base}/photos/${photo.id}`} alt={photo.name} /><span>{photo.name}</span>
            </li>)}</ul>
          </> : null}
          {view.documents.length ? <>
            <h2 className="v-share-h">{copy.documents}</h2>
            <ul className="v-share-docs">{view.documents.map(doc => {
              const voided = doc.status === "voided";
              const title = `${doc.kind === "receipt" ? copy.receiptTitle : copy.statementTitle} ${doc.docNo}`;
              const amount = money(view.currency, doc.totalMinor);
              return <li key={doc.id} className={voided ? "v-share-void" : undefined} data-status={doc.status}>
                <a href={`${base}/documents/${doc.id}`}>
                  <span><span className="v-share-mark">{voided ? copy.markVoid : doc.kind === "receipt" ? copy.markReceipt : copy.markStatement}</span> {title}</span>
                  {voided ? <s><span className="v-share-sr">{copy.markVoid} </span>{amount}</s> : <b>{amount}</b>}
                </a>
              </li>;
            })}</ul>
          </> : null}
        </section>
      </> : <section className="v-token-card v-share-gone" data-state={view.state}>
        <Illustration name="26" />
        <h1>{view.state === "expired" ? copy.expiredTitle : copy.revokedTitle}</h1>
        <p>{view.state === "expired" ? copy.expiredBody.replace("{company}", view.company) : copy.revokedBody}</p>
      </section>}
    </main>
  </div>;
}
