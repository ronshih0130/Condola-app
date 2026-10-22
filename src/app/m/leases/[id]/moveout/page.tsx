import Link from "next/link";
import { notFound } from "next/navigation";
import { LeaseMoveOutWizard } from "@/components/lease-moveout-wizard";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { makeT } from "@/i18n";
import { lifecycleEnabledFor, moveOutContext } from "@/server/lease-lifecycle";
import { COPY, moveOutTitle, moveOutTooEarly, overrideNote, overrideStamp, rentFormula } from "@/server/lease-lifecycle-rules";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function MoveOutPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  if (session.kind !== "staff" || (session.role !== "admin" && session.role !== "manager") || !(await lifecycleEnabledFor(session))) notFound();
  const draft = await moveOutContext(session, id);
  if (!draft) notFound();
  const tenant = displaySampleName(draft.tenant);
  const t = makeT(session.locale);
  const scheduled = draft.scheduled;
  return (
    <>
      <PageHeader title={moveOutTitle(tenant)} crumb={<Link href="/m/leases/expiring">{COPY.listTitle}</Link>} />
      {query.error === "errors.moveOutDate" ? (
        <div className="alert bad" data-testid="move-out-date-error">{moveOutTooEarly(draft.startDate)}</div>
      ) : (
        <ErrorBanner t={t} error={query.error} />
      )}
      {scheduled ? (
        <div className="card pad" data-testid="moveout-scheduled">
          <p data-testid="rent-formula">{rentFormula(draft.rentMajor, scheduled.days, scheduled.defaultMajor)}</p>
          {scheduled.overridden ? <p data-testid="override-note">{overrideNote(scheduled.defaultMajor, scheduled.finalMajor)}</p> : null}
          {scheduled.overridden && scheduled.actor && scheduled.overriddenAt ? (
            <p data-testid="override-stamp">{overrideStamp(scheduled.actor, new Date(scheduled.overriddenAt))}</p>
          ) : null}
          <p><Link className="btn pri" href={`/m/leases/${id}/settlement`} data-testid="goto-settlement">{COPY.settle}</Link></p>
        </div>
      ) : (
        <LeaseMoveOutWizard leaseId={id} startDate={draft.startDate} endDate={draft.endDate} rentMajor={draft.rentMajor} />
      )}
    </>
  );
}
