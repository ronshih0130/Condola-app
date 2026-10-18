import Link from "next/link";
import { makeT } from "@/i18n";
import { ErrorBanner, PageHeader } from "@/components/ui";
import { actionMessage } from "@/server/actions";
import { threadMessages } from "@/server/queries";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

export default async function ThreadPage({
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
  const messages = await threadMessages(session, id);
  return (
    <>
      <PageHeader title={t("i_message")} crumb={<Link href="/m/messages">{t("i_nav_msg")}</Link>} />
      <ErrorBanner t={t} error={query.error} />
      <div className="card pad" style={{ maxWidth: 720 }}>
        {messages.map((message) => (
          <p key={message.id} className={message.mine ? "b" : ""}>
            {message.body}
          </p>
        ))}
        <form action={actionMessage}>
          <input type="hidden" name="threadId" value={id} />
          <textarea className="inp" name="body" rows={3} placeholder={t("i_message")} />
          <button className="btn pri" type="submit" style={{ marginTop: 8 }}>
            {t("i_reply")}
          </button>
        </form>
      </div>
    </>
  );
}
