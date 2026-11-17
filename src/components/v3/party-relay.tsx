import React from "react";
import type { Locale } from "../../i18n";
import { brandV3Copy } from "../../i18n/lanes/brand-v3";
import { ticketRelayCopy } from "../../i18n/lanes/brand-v3-ticket-relay";
import { ownerEstimateRelay, vendorCaseRelay, type OwnerRelayState, type VendorRelayKind } from "../../lib/b3-party-relay";
import { RelayRail } from "./m/tickets/ticket-relay";

/** PLT-52-AC6…AC8 (O-EST-RELAY, O-EST-EMERG, O-EST-DONE-RELAY, O-EST-BACK-DONE). */
export function OwnerEstimateRelay({ state, firm, locale }: { state: OwnerRelayState; firm: string | null; locale: Locale }) {
  const c = ticketRelayCopy(locale), roles = brandV3Copy(locale);
  const nodes = ownerEstimateRelay(state, firm);
  const label = state.kind === "pending"
    ? c.progressCountNow.replace("{n}", c.numerals[nodes.length]).replace("{who}", c.you).replace("{step}", c.steps.approve_estimate)
    : state.kind === "emergency" ? c.progressCount.replace("{n}", c.numerals[nodes.length])
    : c.progressHanded.replace("{result}", c.handedResult[state.decision])
      .replace("{who}", state.decision === "approved" ? roles.v : roles.m)
      .replace("{step}", state.decision === "approved" ? c.steps.do_repair : c.steps.re_estimate);
  return <div className="v3-party-relay" data-testid="owner-estimate-relay" data-relay={state.kind === "decided" ? state.decision : state.kind}>
    <RelayRail nodes={nodes} label={label} locale={locale} />
  </div>;
}

/** PLT-52-AC9 (RV-RELAY, RV-RELAY-WAIT). The caller decides whether a relay is drawn at all (AC10). */
export function VendorCaseRelay({ kind, firm, locale }: { kind: VendorRelayKind; firm: string | null; locale: Locale }) {
  const c = ticketRelayCopy(locale);
  const nodes = vendorCaseRelay(kind, firm);
  const now = nodes.find(node => node.state === "now")!;
  const who = now.party === "v" ? c.you : firm?.trim() || brandV3Copy(locale).m;
  const label = c.progressCountNow.replace("{n}", c.numerals[nodes.length]).replace("{who}", who).replace("{step}", c.steps[now.step]);
  return <div className="v3-party-relay" data-testid="vendor-case-relay" data-relay={kind}>
    <RelayRail nodes={nodes} label={label} locale={locale} />
  </div>;
}
