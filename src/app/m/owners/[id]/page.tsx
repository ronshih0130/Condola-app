import { requireCurrentConsent } from "@/server/consent-gate";
import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { OwnerForm } from "@/components/owner-form";
import { PortalResendEntry } from "@/components/portal-resend-entry";
import { PortalInviteButton } from "@/components/portal-invite-button";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionUpdateOwner } from "@/server/actions";
import { portalLoginReady } from "@/server/portal-invite";
import { listProperties, ownerEditor } from "@/server/queries";
import { isUuid } from "@/server/repair-rules";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function EditOwnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  await requireCurrentConsent(undefined, "page");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const session = await getSession();
  const t = makeT(session.locale);
  const [owner, properties] = await Promise.all([ownerEditor(session, id), listProperties(session)]);
  if (!owner) notFound();
  const ready = session.role === "admin" || session.role === "manager" ? await portalLoginReady(owner.user_id) : false;
  const activated = ready && !owner.invitePending;
  return (
    <>
      <PageHeader title={t("i_owner_edit")} crumb={t("i_owners_title")} />
      <ErrorBanner t={t} error={query.error} />
      <div key={owner.id} data-owner-page={owner.id}>
        {session.role === "admin" || session.role === "manager" ? (
          <PortalInviteButton key={owner.id} kind="owner" contactId={owner.id} activated={activated} />
        ) : null}
        <PortalResendEntry session={session} kind="owner" contactId={owner.id} />
        <OwnerForm
          key={owner.id}
          t={t}
          action={actionUpdateOwner}
          ownerId={owner.id}
          name={owner.name}
          email={owner.email ?? ""}
          phone={owner.phone ?? ""}
          properties={properties.map((property) => ({ id: property.id, name: property.name }))}
          selected={owner.propertyIds}
        />
      </div>
    </>
  );
}
