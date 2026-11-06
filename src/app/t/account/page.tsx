import { notFound } from "next/navigation";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { tenantSessions } from "@/server/tenant-account";
import { tenantProfile } from "@/server/tenant-profile";
import { actionSaveTenantProfile, actionChangeTenantPassword, actionRevokeTenantSession } from "@/server/tenant-account-actions";
import { tenantAccountCopy } from "@/i18n/tenant-account";

export const dynamic = "force-dynamic";

/** B-020 tenant account: signed-in devices. Flag tenant_account_settings OFF ⇒ 404. */
export default async function TenantAccountPage({ searchParams }: { searchParams: Promise<{ done?: string; error?: string }> }) {
  await requireCurrentConsent(undefined, "page");
  const session = await getSession();
  const rows = await tenantSessions(session);
  if (!rows) notFound();
  const profile = await tenantProfile(session);
  if (!profile) notFound();
  const t = tenantAccountCopy(session.locale), params = await searchParams;
  const errorMessage = params.error && ['stale','locked','invalid','reauth','weak','mismatch'].includes(params.error)
    ? t[params.error as 'stale'|'locked'|'invalid'|'reauth'|'weak'|'mismatch'] : t.unavailable;
  const others = rows.filter((r) => !r.current);
  return (
    <section className="card pad" data-testid="tenant-account">
      <h2>{t.title}</h2>
      {params.done === "1" && <p role="status">{t.revoked}</p>}
      {params.done === "profile" && <p role="status">{t.saved}</p>}
      {params.done === "password" && <p role="status">{t.passwordChanged}</p>}
      {params.error && <p role="alert">{errorMessage}</p>}
      <h3>{t.profile}</h3>
      <form action={actionSaveTenantProfile} className="stack">
        <input type="hidden" name="version" value={profile.version} />
        <label>{t.displayName}<input name="displayName" autoComplete="name" required maxLength={100} defaultValue={profile.display_name} /></label>
        <label>{t.phone}<input name="phone" type="tel" autoComplete="tel" required pattern="\+[1-9][0-9]{1,14}" defaultValue={profile.phone_e164} /></label>
        <button type="submit" className="btn">{t.save}</button>
      </form>
      <h3>{t.password}</h3>
      <p className="muted">{t.passwordHint}</p>
      <form action={actionChangeTenantPassword} className="stack">
        <label>{t.currentPassword}<input type="password" name="currentPassword" autoComplete="current-password" required /></label>
        <label>{t.newPassword}<input type="password" name="password" autoComplete="new-password" required minLength={8} maxLength={72} /></label>
        <label>{t.confirmPassword}<input type="password" name="confirm" autoComplete="new-password" required minLength={8} maxLength={72} /></label>
        <button type="submit" className="btn">{t.password}</button>
      </form>
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
