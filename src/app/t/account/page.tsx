import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { tenantSessions } from "@/server/tenant-account";
import { actionRevokeTenantSession } from "@/server/tenant-account-actions";
import { tenantAccountCopy } from "@/i18n/tenant-account";

export const dynamic = "force-dynamic";

/** B-020 tenant account: signed-in devices. Flag tenant_account_settings OFF ⇒ 404. */
export default async function TenantAccountPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const rows = await tenantSessions(session);
  if (!rows) notFound();
  const t = tenantAccountCopy(session.locale), params = await searchParams;
  const others = rows.filter((r) => !r.current);
  return (
    <section className="card pad" data-testid="tenant-account">
      <h2>{t.title}</h2>
      {params.done === "1" && <p role="status">{t.revoked}</p>}
      {params.error && <p role="alert">{t.unavailable}</p>}
      <h3>{t.sessions}</h3>
      <ul>
        {rows.filter((r) => r.current).map((r) => <li key={r.id}>{t.current} · {t.signedIn} {r.created_at}</li>)}
        {others.map((r) => (
          <li key={r.id}>
            {t.signedIn} {r.created_at} · {t.lastActive} {r.last_active_at}
            <form action={actionRevokeTenantSession} style={{ display: "inline" }}>
              <input type="hidden" name="sessionId" value={r.id} />
              <button className="btn sm" type="submit">{t.revoke}</button>
            </form>
          </li>
        ))}
      </ul>
      {others.length === 0 && <p className="muted">{t.none}</p>}
    </section>
  );
}
