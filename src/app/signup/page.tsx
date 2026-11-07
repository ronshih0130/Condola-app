import { actionAbandonUnitQr } from "@/server/unit-qr-actions";
import { cookies } from "next/headers";
import { createUnitQrForm, readUnitQrContinuation, UNIT_QR_COOKIE } from "@/server/unit-qr-signup";
import { unitQrCopy } from "@/i18n/lanes/unit-qr";
import type { Metadata } from "next";
import { makeT } from "@/i18n";
import { AuthBrand } from "@/components/brand";
import { brandV2Enabled } from "@/server/brand-v2";
import { SignupForm } from "@/components/signup-form";
import { requestPrefs } from "@/server/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: { absolute: makeT(prefs.locale)("i_login_title") } };
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const prefs = await requestPrefs();
  const t = makeT(prefs.locale);
  const handle = (await cookies()).get(UNIT_QR_COOKIE)?.value;
  const continuation = await readUnitQrContinuation(handle);
  const qr = continuation.state === "active";
  const formId = qr && handle ? await createUnitQrForm(handle) : null;
  const qrCopy = unitQrCopy(prefs.locale);
  return (
    <div className="auth-wrap">
      <AuthBrand name={t("i_brand")} v2={brandV2Enabled()} />
      <div className="card pad">
        <ol className="steps" data-testid="signup-steps">
          <li className="on">1</li>
          <li>2</li>
          <li>3</li>
          <li>4</li>
        </ol>
        <p className="small muted">{t("i_signup_step", { n: 1 })}</p>
        <h1>{t("i_signup_title")}</h1>
        {qr ? <div data-testid="unit-qr-signup-hint"><p>{qrCopy.signup}</p><p>{qrCopy.invite}</p><form action={actionAbandonUnitQr}><button className="btn">{qrCopy.abandon}</button></form></div> : null}
        {(continuation.state === "invalid" || (qr && !formId)) ? <div role="alert"><p>{qrCopy.required}</p><form action={actionAbandonUnitQr}><button className="btn">{qrCopy.abandon}</button></form></div> : <SignupForm error={params.error} {...(formId ? { unitQr: formId } : {})} />}
      </div>
    </div>
  );
}
