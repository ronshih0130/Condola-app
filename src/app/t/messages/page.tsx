import { requireCurrentConsent } from "@/server/consent-gate";
import { makeT } from "@/i18n";
import { ErrorBanner } from "@/components/ui";
import { actionMessage, actionStartTenantThread } from "@/server/actions";
import { randomUUID } from "node:crypto";
import { tenantThreadCreateEnabled } from "@/server/tenant-thread";
import { threadMessages } from "@/server/queries";
import { displaySampleName } from "@/server/sandbox-data";
import { selectedLease } from "@/lib/tenant-lease";

export const dynamic = "force-dynamic";

export default async function TenantMessagesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const { session, lease } = await selectedLease();
  const t = makeT(session.locale);
  const params = await searchParams;
  if (!lease) return <p>{t("i_empty")}</p>;
  const messages = lease.thread_id ? await threadMessages(session, lease.thread_id) : [];
  const canStart = !lease.thread_id && await tenantThreadCreateEnabled(session);
  return (
    <div>
      <h2>{t("i_rich_msg")}</h2>
      <ErrorBanner t={t} error={params.error} />
      <p className="small">{t("i_context", { firm: lease.firm_name, place: displaySampleName(`${lease.property_name} ${lease.room_label ?? ""}`.trim()) })}</p>
      {messages.map((message) => (
        <p key={message.id} className={message.mine ? "b" : ""}>
          {message.body}
        </p>
      ))}
      {lease.thread_id ? (
        <form action={actionMessage}>
          <input type="hidden" name="threadId" value={lease.thread_id} />
          <input type="hidden" name="returnTo" value="tenant" />
          <textarea className="inp" name="body" rows={3} placeholder={t("i_message")} />
          <button className="btn pri" type="submit" style={{ marginTop: 8 }}>
            {t("i_send")}
          </button>
        </form>
      ) : canStart ? (
        <form action={actionStartTenantThread} data-testid="tenant-thread-start">
          <input type="hidden" name="leaseId" value={lease.lease_id} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <textarea className="inp" name="body" rows={3} placeholder={t("i_message")} maxLength={4000} required />
          <button className="btn pri" type="submit" style={{ marginTop: 8 }}>
            {t("i_send")}
          </button>
        </form>
      ) : (
        <p className="muted">{t("i_empty")}</p>
      )}
    </div>
  );
}
