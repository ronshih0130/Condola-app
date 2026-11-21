import { ManagementEmptyState } from "@/components/management-empty-state";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { can } from "@/server/perms";
import { listOwnerDirectory } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function OwnersPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const rows = await listOwnerDirectory(session);
  const editable = can(session, "props.edit");
  return (
    <>
      <PageHeader
        title={t("i_owners_title")}
        actions={
          editable && rows.length > 0 ? (
            <Link className="btn pri" href="/m/owners/new" data-testid="new-owner">
              + {t("i_owner_new")}
            </Link>
          ) : null
        }
      />
      <div className="card">
        {rows.length === 0 ? <ManagementEmptyState session={session} page="OWN" /> : (
        <table className="t rf" data-testid="owner-list">
          <thead>
            <tr>
              <th>{t("i_owner")}</th>
              <th>{t("i_owner_email")}</th>
              <th>{t("i_phone_label")}</th>
              <th>{t("i_assign_properties")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={`owner-row-${row.email ?? row.id}`}>
                <td>
                  <b>{displaySampleName(row.name)}</b>
                </td>
                <td data-label={t("i_owner_email")}>{row.email}</td>
                <td data-label={t("i_phone_label")}>{row.phone || "—"}</td>
                <td data-label={t("i_assign_properties")}>{row.properties ? displaySampleName(row.properties) : "—"}</td>
                <td className="r">
                  {editable ? (
                    <Link className="btn sm" href={`/m/owners/${row.id}`}>
                      {t("i_edit")}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}
      </div>
    </>
  );
}
