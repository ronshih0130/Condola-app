import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Locale } from "../../../../i18n";
import { propertyCopy } from "../../../../i18n/lanes/brand-v3-property";
import { sharedMeterCopy } from "../../../../i18n/lanes/brand-v3-shared-meter";
import { sharedMeterView, type MeterSpace, type SharedMeterView } from "../../../../server/b109-shared-meter";
import type { Session } from "../../../../server/types";
import { displaySampleName } from "../../../../server/sandbox-data";
import { SharedMeterForm } from "./form";

/** 「3F A」 for a room (the property page's unit + room), 「5F」 for a whole unit. */
export const spaceLabel = (space: MeterSpace) => space.label === null ? displaySampleName(space.unitLabel)
  : `${displaySampleName(space.unitLabel)} ${displaySampleName(space.label)}`;
export const sharedMeterHref = (propertyId: string) => `/m/properties/${encodeURIComponent(propertyId)}/shared-meter`;

/** ADV-METER page body. brand_v3 or shared_meter OFF is a 404; P-ACC / P-MNT get the property area's own 403 text. */
export async function SharedMeterPage({ session, propertyId }: { session: Session; propertyId: string }) {
  const data = await sharedMeterView(session, propertyId);
  if (data.state === "off") notFound();
  return <SharedMeterBody data={data} propertyId={propertyId} locale={session.locale} />;
}

export function SharedMeterBody({ data, propertyId, locale }: { data: Exclude<SharedMeterView, { state: "off" }>; propertyId: string; locale: Locale }) {
  const c = sharedMeterCopy(locale), p = propertyCopy(locale);
  const back = `/m/properties/${encodeURIComponent(propertyId)}`;
  const head = <header className="v3-meter-head"><h1>{c.title}</h1><p>{c.lead}</p></header>;
  if (data.state === "forbidden") return <section className="v3-meter" data-testid="shared-meter">{head}<p role="status">{p.permission}</p></section>;
  if (data.state !== "ready") return <section className="v3-meter" data-testid="shared-meter">{head}
    <div role="alert"><p>{p.failed}</p><Link className="btn pri" href={sharedMeterHref(propertyId)}>{p.retry}</Link></div></section>;
  return <section className="v3-meter" data-testid="shared-meter">{head}
    <div className="v3-meter-two">
      <SharedMeterForm locale={locale} propertyId={propertyId} backHref={back} spaces={data.spaces.map(s => ({ id: s.id, label: spaceLabel(s) }))} config={data.config}
        nextEffectiveFrom={data.nextEffectiveFrom} />
      <aside className="v3-meter-card v3-meter-aside"><p>{c.aside}</p></aside>
    </div>
  </section>;
}
