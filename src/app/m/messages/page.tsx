import { ManagementEmptyState } from "@/components/management-empty-state";
import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { listThreads } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const threads = await listThreads(session);
  return (
    <>
      <PageHeader title={t("i_nav_msg")} />
      <div className="card">
        {threads.length === 0 ? (
          <ManagementEmptyState session={session} page="MSG" />
        ) : (
          <table className="t rf">
            <tbody>
              {threads.map((thread) => (
                <tr key={thread.id}>
                  <td>
                    <Link href={`/m/messages/${thread.id}`}>
                      <b>{displaySampleName(thread.tenant)}</b>
                    </Link>
                    <div className="small muted">{displaySampleName(thread.place)}</div>
                    <div className="small">{thread.preview}</div>
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
