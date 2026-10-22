import Link from "next/link";
import { notFound } from "next/navigation";
import { LeaseRenewForm } from "@/components/lease-renew-form";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { makeT } from "@/i18n";
import { lifecycleEnabledFor, renewalContext } from "@/server/lease-lifecycle";
import { COPY, renewalSuccess, renewalTitle } from "@/server/lease-lifecycle-rules";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function RenewLeasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; created?: string; start?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  if (session.kind !== "staff" || (session.role !== "admin" && session.role !== "manager") || !(await lifecycleEnabledFor(session))) notFound();
  const draft = await renewalContext(session, id);
  if (!draft) notFound();
  const tenant = displaySampleName(draft.tenant);
  const t = makeT(session.locale);
  return (
    <>
      <PageHeader title={renewalTitle(tenant)} crumb={<Link href="/m/leases/expiring">{COPY.listTitle}</Link>} />
      <ErrorBanner t={t} error={query.error} />
      {query.created === "1" && query.start ? (
        <div className="alert ok" data-testid="renewal-created" role="status">{renewalSuccess(query.start)}</div>
      ) : null}
      {draft.alreadyRenewed && query.created !== "1" ? (
        <p data-testid="renew-pending-note">{COPY.pendingNote}</p>
      ) : null}
      {!draft.alreadyRenewed ? (
        <LeaseRenewForm
          leaseId={id}
          oldEnd={draft.endDate}
          rentMajor={draft.rentMajor}
          depositMajor={draft.depositMajor}
          start={draft.start}
          end={draft.end}
        />
      ) : null}
    </>
  );
}
