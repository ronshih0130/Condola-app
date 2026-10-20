import { makeT } from "@/i18n";
import { OwnerForm } from "@/components/owner-form";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionCreateOwner } from "@/server/actions";
import { listProperties } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NewOwnerPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const properties = await listProperties(session);
  return (
    <>
      <PageHeader title={t("i_owner_new")} crumb={t("i_owners_title")} />
      <ErrorBanner t={t} error={params.error} />
      <OwnerForm
        t={t}
        action={actionCreateOwner}
        properties={properties.map((property) => ({ id: property.id, name: property.name }))}
        selected={[]}
      />
    </>
  );
}
