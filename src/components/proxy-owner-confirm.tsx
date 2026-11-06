"use client";

import { useState } from "react";
import { PROXY_CONFIRM_LABEL } from "@/server/b010-proxy-confirm-rules";

export function useProxyOwnerConfirm(required: boolean) {
  const [confirmed, setConfirmed] = useState(false);
  return { confirmed, setConfirmed, canSubmit: !required || confirmed };
}

export function ProxyOwnerConfirmField({ required }: { required: boolean }) {
  const { confirmed, setConfirmed } = useProxyOwnerConfirm(required);

  if (!required) return null;

  return (
    <label>
      <input
        type="checkbox"
        name="proxyOwnerConfirmed"
        value="true"
        checked={confirmed}
        onChange={(event) => setConfirmed(event.target.checked)}
        required
        data-testid="proxy-owner-confirm"
      />
      {PROXY_CONFIRM_LABEL}
    </label>
  );
}
