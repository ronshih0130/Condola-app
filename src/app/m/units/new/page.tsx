import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { SpaceForm } from "@/components/space-form";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionCreateSpace } from "@/server/actions";
import { listOwners, listProperties } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function NewSpacePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const [properties, owners] = await Promise.all([listProperties(session), listOwners(session)]);
  return (
    <>
      <PageHeader title={t("i_space_new")} crumb={t("i_units_title")} />
      <ErrorBanner t={t} error={params.error} />
      <SpaceForm
        action={actionCreateSpace}
        properties={properties.map((property) => ({ id: property.id, name: property.name }))}
        owners={owners}
      />
    </>
  );
}
