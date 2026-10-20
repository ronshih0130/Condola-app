"use client";

import { useEffect, useState } from "react";
import { actionConfirmSupabase, actionConfirmSupabaseHash, actionConfirmToken } from "@/server/signup-actions";

export function ConfirmToken({ token }: { token: string }) {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started || !token) return;
    setStarted(true);
    void actionConfirmToken(token);
  }, [started, token]);
  return null;
}

export function ConfirmSupabaseHash({ tokenHash }: { tokenHash: string }) {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started || !tokenHash) return;
    setStarted(true);
    void actionConfirmSupabaseHash(tokenHash);
  }, [started, tokenHash]);
  return null;
}

export function ConfirmHash() {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (started) return;
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access = hash.get("access_token");
    if (!access) return;
    setStarted(true);
    void actionConfirmSupabase(access);
  }, [started]);
  return null;
}
