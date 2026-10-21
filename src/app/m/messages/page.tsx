import Link from "next/link";
import { makeT } from "@/i18n";
import { PageHeader } from "@/components/ui";
import { listThreads } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const session = await getSession();
  const t = makeT(session.locale);
  const threads = await listThreads(session);
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
                      <b>{thread.tenant}</b>
                    </Link>
                    <div className="small muted">{thread.place}</div>
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
