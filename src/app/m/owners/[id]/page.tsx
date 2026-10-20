import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { OwnerForm } from "@/components/owner-form";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionUpdateOwner } from "@/server/actions";
import { listProperties, ownerEditor } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function EditOwnerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const session = await getSession();
  const t = makeT(session.locale);
  const [owner, properties] = await Promise.all([ownerEditor(session, id), listProperties(session)]);
  if (!owner) notFound();
  return (
    <>
      <PageHeader title={t("i_owner_edit")} crumb={t("i_owners_title")} />
      <ErrorBanner t={t} error={query.error} />
      <OwnerForm
        t={t}
        action={actionUpdateOwner}
        ownerId={owner.id}
        name={owner.name}
        email={owner.email ?? ""}
        phone={owner.phone ?? ""}
        properties={properties.map((property) => ({ id: property.id, name: property.name }))}
        selected={owner.propertyIds}
      />
    </>
  );
}
