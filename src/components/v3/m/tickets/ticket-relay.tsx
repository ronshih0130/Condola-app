import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { brandV3Copy, brandV3NavigationCopy } from "../../../../i18n/lanes/brand-v3";
import { ticketRelayCopy } from "../../../../i18n/lanes/brand-v3-ticket-relay";
import type { RelayNode, RelaySub } from "../../../../lib/b3-ticket-relay";
import type { TicketRelay } from "../../../../server/b3-ticket-relay";
import { statusKey } from "../../../ui";
import { RoleAvatar } from "../../role-avatar";
import { TurnTag } from "../../turn-tag";

function subText(sub: RelaySub, locale: Locale): string {
  const c = ticketRelayCopy(locale);
  if (sub.kind === "name") return sub.text;
  if (sub.kind === "you") return c.you;
  if (sub.kind === "sent_back") return c.sentBack;
  return brandV3Copy(locale).m;
}

/** PLT-52-AC1: navy up to the current step; the current label is the navy pill; later steps dimmed.
 * No completion tick anywhere (MGT-150-AC5); no day count (PLT-53-AC5). */
export function RelayRail({ nodes, label, locale }: { nodes: RelayNode[]; label: string; locale: Locale }) {
  const c = ticketRelayCopy(locale);
  return <ol className="v3-rail" aria-label={label} data-testid="ticket-relay">
    {nodes.map((node, i) => <li key={`${i}:${node.party}:${node.step}`} className={`v3-st ${node.state}`} data-state={node.state} data-party={node.party}>
      <RoleAvatar role={node.party} locale={locale} />
      <span className="v3-st-l">{node.state === "now" ? <TurnTag>{c.steps[node.step]}</TurnTag> : c.steps[node.step]}</span>
      {node.subs.map((sub, j) => <span className="v3-st-s" key={j}>{subText(sub, locale)}</span>)}
    </li>)}
  </ol>;
}

/** TK-RELAY / TK-RELAY-MNT head and relay card for /m/tickets/[id] under brand_v3. */
export function TicketRelayV3({ relay, place, item, locale }: {
  relay: TicketRelay; place: string; item: string; locale: Locale;
}) {
  const c = ticketRelayCopy(locale), t = makeT(locale);
  const title = c.title.replace("{place}", place).replace("{item}", item);
  let lead: string | null = null, card: React.ReactNode = null;
  if (relay.state === "ready" && relay.view === "maintenance") {
    // MGT-150-AC2: the ticket's existing status, no timing, no why-line.
    lead = c.statusLine.replace("{status}", t(statusKey(relay.relay.status)));
    if (relay.relay.nodes) card = <RelayRail nodes={relay.relay.nodes} label={c.progress} locale={locale} />;
  } else if (relay.state === "ready") {
    const r = relay.relay;
    if (r.lead) lead = c.reEstimateLead.replace("{name}", r.lead.owner);
    if (r.nodes) {
      const who = r.now ? r.now.you ? c.you : `${brandV3Copy(locale)[r.now.party]}${r.now.name ?? ""}` : "";
      const label = r.now ? c.progressNow.replace("{who}", who).replace("{step}", c.steps[r.now.step]) : c.progress;
      card = <>
        <RelayRail nodes={r.nodes} label={label} locale={locale} />
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
