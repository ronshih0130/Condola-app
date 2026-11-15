import { OwnerHomeV3 } from "@/components/v3/owner/home";
import { ownerHomeEstimates } from "@/server/owner-home-v3";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { NotificationCenterEntry } from "@/components/notification-center-entry";
import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ownerPrivacy } from "@/server/auth";
import { brandV2EnabledForOrg } from "@/server/brand-v2";
import { moneyLabel } from "@/server/format";
import { ownerHome } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnerHomePage({ searchParams }: { searchParams?: Promise<{ estimate?: string | string[] }> } = {}) {
  await requireCurrentConsent(undefined, "page");
  const session = await guardEffectiveSession(await getSession(), null);
  const v2 = await brandV2EnabledForOrg(session.orgId);
  const t = makeT(session.locale);
  const v3 = await brandV3EnabledForOrg(session.orgId);
  const legacyData = await Promise.all([ownerHome(session), ownerPrivacy(session.orgId)]).catch(error => {
    if (!v3) throw error;
    return null;
  });
  if (!legacyData) return <OwnerHomeV3 name={session.name} locale={session.locale} state={{ status: "error" }} />;
  const [rows, privacy] = legacyData;
  const legacy = (
    <div data-v2-page={v2 ? "o-home" : undefined}>
      <h2>{t("i_hello", { name: session.name })}</h2>
      <NotificationCenterEntry session={session} />
      <p className="small" data-testid="managed-by">{t("i_managed_by", { firm: privacy.name, brand: t("i_brand") })}</p>
      <table className="t">
        <tbody>
          {rows.map((row) => (
            <tr key={row.lease_id}>
              <td>
                <b data-testid="tenant-name">{privacy.showName ? displaySampleName(row.tenant_name) : t("i_tenant_hidden")}</b>
                <div className="small muted">
                  {displaySampleName([row.property_name, row.unit_label, row.room_label].filter(Boolean).join(" "))}
                </div>
              </td>
              <td className="num" data-v2-negative={v2 && Number(row.rent) < 0 ? "true" : undefined}>{moneyLabel(Number(row.rent), row.currency, session.locale)}</td>
              <td
                data-testid="tenant-phone"
                data-visible={privacy.showPhone && row.phone_visible ? "true" : "false"}
              >
                {privacy.showPhone && row.phone_visible && row.tenant_phone ? row.tenant_phone : t("i_phone_hidden")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  if (!v3) return legacy;
  const state = await ownerHomeEstimates(session);
  const estimate = (await searchParams)?.estimate;
  return <>
    <OwnerHomeV3 name={session.name} locale={session.locale} state={state} estimate={typeof estimate === "string" ? estimate : undefined} />
    {state.status === "ready" ? <div className="v3-owner-legacy card pad">{legacy}</div> : null}
  </>;
}
