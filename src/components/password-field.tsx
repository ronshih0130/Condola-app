"use client";

import { useState } from "react";
import { passwordIssues } from "@/server/password";
import { useT } from "./locale";

export function PasswordFields({ testId = "new-password" }: { testId?: string }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const issues = passwordIssues(password);
  const mismatching = confirm.length > 0 && password !== confirm;
  return (
    <>
      <div className="fg">
        <label className="f">{t("i_password")}</label>
        <input
          className="inp"
          name="password"
          type="password"
          data-testid={testId}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
        <ul className="hint" data-testid="password-rules">
          <li data-ok={issues.includes("length") ? "false" : "true"}>{t("i_pw_length")}</li>
          <li data-ok={issues.includes("alnum") ? "false" : "true"}>{t("i_pw_alnum")}</li>
          <li data-ok={issues.includes("common") ? "false" : "true"}>{t("i_pw_common")}</li>
        </ul>
      </div>
      <div className="fg">
        <label className="f">{t("i_password_confirm")}</label>
        <input
          className="inp"
          name="confirm"
          type="password"
          data-testid="password-confirm"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
        />
        {mismatching ? <div className="hint">{t("i_pw_mismatch")}</div> : null}
      </div>
    </>
  );
}
