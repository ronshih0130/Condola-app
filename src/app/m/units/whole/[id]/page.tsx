import { notFound } from "next/navigation";
import { makeT } from "@/i18n";
import { ReadOnlyNotice } from "@/components/plan-units";
import { SpaceForm } from "@/components/space-form";
import { SpaceRepairs } from "@/components/space-repairs";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionUpdateSpace } from "@/server/actions";
import { majorField } from "@/server/portfolio";
import { listOwners, listProperties, spaceEditor, spaceRepairs } from "@/server/queries";
import { getSession } from "@/server/session";
import { spaceIsEditable } from "@/server/unit-limit-store";

export const dynamic = "force-dynamic";

export default async function EditWholeUnitPage({
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
  const [space, properties, owners, repairs, editable] = await Promise.all([
    spaceEditor(session, "whole_unit", id),
    listProperties(session),
    listOwners(session),
    spaceRepairs(session, { unitId: id }),
    spaceIsEditable(session, id),
  ]);
  if (!space) notFound();
  const propertyName = properties.find((property) => property.id === space.propertyId)?.name ?? "";
  return (
    <>
      <PageHeader
        title={
          <span className="readonly-title">
            {t("i_space_edit")}
            {editable ? null : (
              <span className="chip" data-testid="readonly-pill">
                {t("i_plan_s16_readonly")}
              </span>
            )}
          </span>
        }
        crumb={t("i_units_title")}
      />
      <ErrorBanner t={t} error={query.error} />
      {editable ? null : <ReadOnlyNotice t={t} kind="unit" />}
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
          kind: "whole_unit",
          floor: space.floor,
          area: space.area,
          rent: majorField(space.rentMinor, space.currency),
          electricityMethod: space.electricityMethod,
          ratePerKwh: space.ratePerKwh,
          rateCapReason: space.rateCapReason,
          taipowerKwh: space.taipowerKwh,
          taipowerAmount: majorField(space.taipowerAmountMinor, space.currency),
          notes: space.notes,
        }}
        locked={!editable}
      />
      <SpaceRepairs
        t={t}
        locale={session.locale}
        repairs={repairs}
        href={`/m/tickets?property=${space.propertyId}&unit=${space.id}`}
      />
    </>
  );
}
