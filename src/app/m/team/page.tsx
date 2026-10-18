import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionInvite } from "@/server/actions";
import { listTeam } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function TeamPage({ searchParams }: { searchParams: Promise<{ error?: string; code?: string }> }) {
  const session = await getSession();
  const t = makeT(session.locale);
  const params = await searchParams;
  const team = await listTeam(session);
  const roleKey: Record<string, string> = {
    admin: "i_role_admin",
    manager: "i_role_manager",
    accountant: "i_role_accountant",
    maintenance: "i_role_maintenance",
  };
  return (
    <>
      <PageHeader title={t("s_1091b77")} />
      <ErrorBanner t={t} error={params.error} />
      {params.code ? <div className="alert info">{t("i_team_code", { code: params.code })}</div> : null}
      <div className="grid2">
        <div className="card">
          <table className="t">
            <tbody>
              {team.map((member) => (
                <tr key={member.email ?? member.name}>
                  <td>{member.name}</td>
                  <td className="small">{member.email}</td>
                  <td>
                    <span className="chip pri">{t(roleKey[member.role] ?? "i_role_label")}</span>
                  </td>
                  <td>{member.status === "active" ? t("i_active") : member.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {session.role === "admin" ? (
          <form className="card pad" action={actionInvite}>
            <h3>{t("s_f320582")}</h3>
            <div className="fg">
              <label className="f">{t("i_invite_email")}</label>
              <input className="inp" name="email" placeholder={t("i_ph_email")} defaultValue="" />
            </div>
            <div className="fg">
              <label className="f">{t("i_role_label")}</label>
              <select className="inp" name="role" defaultValue="" data-testid="invite-role">
                <option value="">{t("i_choose")}</option>
                <option value="manager">{t("i_role_manager")}</option>
                <option value="accountant">{t("i_role_accountant")}</option>
                <option value="maintenance">{t("i_role_maintenance")}</option>
              </select>
            </div>
            <button className="btn pri" type="submit">
              {t("s_1af94ab")}
            </button>
          </form>
        ) : null}
      </div>
    </>
  );
}
