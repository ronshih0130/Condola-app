import React from "react";
import Link from "next/link";
import type { Locale } from "../../../../i18n";
import { brandV3Copy, brandV3NavigationCopy } from "../../../../i18n/lanes/brand-v3";
import { ticketRelayCopy } from "../../../../i18n/lanes/brand-v3-ticket-relay";
import type { RelayEnd, RelayNode, RelaySub } from "../../../../lib/b3-ticket-relay";
import type { TicketRelay } from "../../../../server/b3-ticket-relay";
import { RoleAvatar } from "../../role-avatar";
import { TurnTag } from "../../turn-tag";
import { WaitMark } from "../../wait-mark";

function subText(sub: RelaySub, locale: Locale): string {
  const c = ticketRelayCopy(locale);
  if (sub.kind === "name") return sub.text;
  if (sub.kind === "you") return c.you;
  if (sub.kind === "sent_back") return c.sentBack;
  if (sub.kind === "more_info") return c.moreInfo;
  if (sub.kind === "approved") return c.approved;
  if (sub.kind === "sent") return c.sent;
  if (sub.kind === "tenant") return brandV3Copy(locale).t;
  if (sub.kind === "vendor") return brandV3Copy(locale).v;
  return brandV3Copy(locale).m;
}

/** PLT-52-AC1: navy up to the current step; the current label is the navy pill; later steps dimmed.
 * TK-RELAY-END: a finished relay ends with a grey status pill. No completion tick anywhere
 * (MGT-150-AC5); no day count (PLT-53-AC5). */
export function RelayRail({ nodes, end, label, locale }: { nodes: RelayNode[]; end?: RelayEnd | null; label: string; locale: Locale }) {
  const c = ticketRelayCopy(locale);
  return <ol className="v3-rail" aria-label={label} data-testid="ticket-relay">
    {nodes.map((node, i) => <li key={`${i}:${node.party}:${node.step}`}
      className={`v3-st ${node.state}${node.wait ? " wt" : ""}${node.plain ? " plain" : ""}`} data-state={node.state} data-party={node.party}
      data-wait={node.wait ? "true" : undefined}>
      <RoleAvatar role={node.party} locale={locale} />
      <span className="v3-st-l">{node.state === "now" ? <TurnTag>{c.steps[node.step]}</TurnTag> : c.steps[node.step]}</span>
      {/* GS-61 / GS-62: a handed-over step shows the clock beside its first sub; never a tick. */}
      {node.subs.map((sub, j) => <span className={`v3-st-s${node.wait && j === 0 ? " v3-st-wait" : ""}`} key={j}>
        {node.wait && j === 0 ? <><WaitMark /><span className="v3-st-t">{subText(sub, locale)}</span></> : subText(sub, locale)}</span>)}
    </li>)}
    {end && <li className="v3-st end" data-state="end"><span className="v3-end-pill">{c.end[end]}</span></li>}
  </ol>;
}

/** TK-RELAY / TK-RELAY-MNT head and relay card for /m/tickets/[id] under brand_v3. */
export function TicketRelayV3({ relay, place, item, locale }: {
  relay: TicketRelay; place: string; item: string; locale: Locale;
}) {
  const c = ticketRelayCopy(locale);
  const title = c.title.replace("{place}", place).replace("{item}", item);
  let lead: string | null = null, card: React.ReactNode = null;
  if (relay.state === "ready" && relay.view === "maintenance") {
    // MGT-150-AC2 / TK-RELAY-MNT-STATES: the status in the approved progress words, no timing, no why-line.
    lead = c.statusLine.replace("{status}", c.mntStatus[relay.relay.word]);
    card = <RelayRail nodes={relay.relay.nodes} end={relay.relay.end} label={c.progress} locale={locale} />;
  } else if (relay.state === "ready") {
    const r = relay.relay;
    if (r.lead) lead = c.lead[r.lead.kind].replace("{name}", r.lead.name);
    if (r.nodes) {
      const who = r.now ? r.now.you ? c.you : `${brandV3Copy(locale)[r.now.party]}${r.now.name ?? ""}` : "";
      const label = r.now ? c.progressNow.replace("{who}", who).replace("{step}", c.steps[r.now.step]) : c.progress;
      card = <>
        <RelayRail nodes={r.nodes} end={r.end} label={label} locale={locale} />
        {r.why && <p className="v3-why" data-testid="ticket-relay-why">{c.why[r.why]}</p>}
      </>;
    }
  }
  return <div className="v3-ticket" data-testid="v3-ticket-relay">
    <nav className="v3-ticket-crumb" aria-label={brandV3NavigationCopy(locale).maintenance}>
      <Link href="/m/tickets">{brandV3NavigationCopy(locale).maintenance}</Link>
      <span aria-hidden="true"> {c.crumbSep} </span><span>{title}</span>
    </nav>
    <div className="v3-ticket-head">
      <h1>{title}</h1>
      {lead && <p data-testid="ticket-relay-lead">{lead}</p>}
    </div>
    {card && <section className="v3-ticket-card">{card}</section>}
  </div>;
}
