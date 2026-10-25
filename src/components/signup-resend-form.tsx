"use client";

import { useEffect, useState } from "react";
import { PendingSubmit } from "./pending-submit";
import { actionResendSignup } from "@/server/signup-actions";

function clampWait(wait: number) {
  if (!Number.isFinite(wait) || wait <= 0) return 0;
  return Math.min(60, Math.ceil(wait));
}

export function SignupResendForm({
  email,
  emailLabel,
  back,
  wait,
  idle,
  pending,
  cooling,
  success,
  error,
  waiting,
  testId,
  primary,
}: {
  email: string;
  emailLabel?: string;
  back?: string;
  wait: number;
  idle: string;
  pending: string;
  cooling: string;
  success?: string;
  error?: string;
  waiting?: string;
  testId: string;
  primary?: boolean;
}) {
  const [left, setLeft] = useState(() => clampWait(wait));
  useEffect(() => {
    setLeft(clampWait(wait));
  }, [wait]);
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft((current) => (current > 0 ? current - 1 : 0)), 1000);
    return () => clearTimeout(id);
  }, [left]);
  return (
    <form action={actionResendSignup} className={emailLabel ? "col" : undefined}>
      {success ? (
        <div className="alert ok" data-testid="resend-success" role="status">
          {success}
        </div>
      ) : null}
      {error ? (
        <div className="alert bad" data-testid="resend-error" role="alert">
          {error}
        </div>
      ) : null}
      {waiting ? (
        <div className="alert warn" data-testid="resend-wait" role="status">
          {waiting}
        </div>
      ) : null}
      {emailLabel ? (
        <div className="fg">
          <label className="f">{emailLabel}</label>
          <input className="inp" name="email" type="email" required defaultValue={email} data-testid="expired-email" />
        </div>
      ) : (
        <input type="hidden" name="email" value={email} />
      )}
      {back ? <input type="hidden" name="back" value={back} /> : null}
      <PendingSubmit
        className={primary ? "btn pri" : "btn"}
        idle={left > 0 ? cooling.replaceAll("{n}", String(left)) : idle}
        pending={pending}
        testId={testId}
        disabled={left > 0}
      />
    </form>
  );
}
