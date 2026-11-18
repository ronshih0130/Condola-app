import { redirect } from "next/navigation";
import { brandV3EnabledForOrg } from "@/server/brand-v3";
import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionOwnerPrivacy } from "@/server/auth-actions";
import { ownerPrivacy } from "@/server/auth";
import { can, PERMS, ROLE_KEYS } from "@/server/perms";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function RolesPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await guardEffectiveSession(await getSession(), "settings.edit");
  const params = await searchParams;
  const t = makeT(session.locale);
  // R5-OWNVIEW (MGT-138 route move): under brand_v3 the two owner-privacy switches live on /m/settings, so this
  // page no longer reads or shows them. Flag OFF keeps today's form.
  const v3 = await brandV3EnabledForOrg(session.orgId);
  // R5-TEAM (MGT-133-AC1): under brand_v3 there is no separate 角色權限 page; the old route opens 團隊 with the
  // permission table open. A custom role without team.manage (it cannot open 團隊) keeps this read-only table.
  if (v3 && can(session, "team.manage")) redirect("/m/team?perms=1#v3-team-perms");
  const privacy = v3 ? null : await ownerPrivacy(session.orgId);
  const roleLabel: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  return (
    <>
      <PageHeader title={t("i_roles_title")} />
      <ErrorBanner t={t} error={params.error} />
      {params.saved === "1" ? <div className="alert ok">{t("i_saved")}</div> : null}
      <div className="card">
        <table className="t" data-testid="perm-matrix">
          <thead>
            <tr>
              <th>{t("i_permission")}</th>
              {ROLE_KEYS.map((role) => (
                <th key={role} className={role === session.role ? "mine" : ""}>
                  {t(roleLabel[role])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMS.map(([key, label, roles]) => (
              <tr key={key} data-perm={key}>
                <td>{t(label)}</td>
                {ROLE_KEYS.map((role) => (
                  <td key={role} className={role === session.role ? "mine" : ""}>
                    {(roles as readonly string[]).includes(role) ? "✓" : "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {privacy && can(session, "settings.edit") ? (
        <form className="card pad" action={actionOwnerPrivacy} style={{ marginTop: 16, maxWidth: 640 }}>
          <h3>{t("i_owner_privacy")}</h3>
          <label className="row">
            <input type="checkbox" name="showName" defaultChecked={privacy.showName} data-testid="privacy-name" />
            {t("i_show_tenant_name")}
          </label>
          <label className="row">
            <input type="checkbox" name="showPhone" defaultChecked={privacy.showPhone} data-testid="privacy-phone" />
            {t("i_show_tenant_phone")}
          </label>
          <p className="small muted">{t("i_owner_privacy_note")}</p>
          <button className="btn pri" type="submit">
            {t("i_save")}
          </button>
        </form>
      ) : null}
    </>
  );
}
