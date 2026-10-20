import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { SpaceForm } from "@/components/space-form";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionUpdateSpace } from "@/server/actions";
import { majorField } from "@/server/portfolio";
import { listOwners, listProperties, spaceEditor } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function EditRoomPage({
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
  const [space, properties, owners] = await Promise.all([
    spaceEditor(session, "room", id),
    listProperties(session),
    listOwners(session),
  ]);
  if (!space) notFound();
  const propertyName = properties.find((property) => property.id === space.propertyId)?.name ?? "";
  return (
    <>
      <PageHeader title={t("i_space_edit")} crumb={t("i_units_title")} />
      <ErrorBanner t={t} error={query.error} />
      <SpaceForm
        action={actionUpdateSpace}
        spaceId={space.id}
        lockProperty
        lockKind
        propertyName={propertyName}
        properties={properties.map((property) => ({ id: property.id, name: property.name }))}
        owners={owners}
        defaults={{
          propertyId: space.propertyId,
          ownerContactId: space.ownerContactId ?? "",
          kind: "room",
          floor: space.floor,
          roomLabel: space.roomLabel,
          roomType: space.roomType,
          area: space.area,
          rent: majorField(space.rentMinor, space.currency),
          electricityMethod: space.electricityMethod,
          ratePerKwh: space.ratePerKwh,
          rateCapReason: space.rateCapReason,
          taipowerKwh: space.taipowerKwh,
          taipowerAmount: majorField(space.taipowerAmountMinor, space.currency),
          notes: space.notes,
        }}
      />
    </>
  );
}
