import { requireCurrentConsent } from "@/server/consent-gate";
import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { listThreads } from "@/server/queries";
import { staffOwnerCopy } from "@/i18n/owner-replies-messages";
import { staffOwnerThreads } from "@/server/owner-replies-messages";
import { displaySampleName } from "@/server/sandbox-data";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const t = makeT(session.locale);
  const threads = await listThreads(session);
  // B-023: owner <-> company threads, separate query; null (nothing rendered) when owner_portal_extensions is OFF.
  const ownerThreads = await staffOwnerThreads(session);
  const oc = ownerThreads ? staffOwnerCopy(session.locale) : null;
  return (
    <>
      <PageHeader title={t("i_nav_msg")} />
      <div className="card">
        {threads.length === 0 ? (
          <div className="empty">{t("i_empty")}</div>
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
      {ownerThreads && oc ? (
        <div className="card" data-testid="staff-owner-threads" style={{ marginTop: 16 }}>
          <div className="pad"><b>{oc.threadsTitle}</b><div className="small muted">{oc.threadsNote}</div></div>
          {ownerThreads.length === 0 ? (
            <div className="empty">{t("i_empty")}</div>
          ) : (
            <table className="t rf">
              <tbody>
                {ownerThreads.map((thread) => (
                  <tr key={thread.thread_id} data-testid="staff-owner-thread">
                    <td>
                      <Link href={`/m/messages/${thread.thread_id}`}>
                        <b>{oc.owner(displaySampleName(thread.owner_name))}</b>
                      </Link>
                      <div className="small muted">{displaySampleName(thread.property_name)}</div>
                      <div className="small">{thread.preview}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  );
}
