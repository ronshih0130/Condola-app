"use client";

import { useEffect } from "react";
import { actionClearBackup } from "@/server/auth-actions";

export function BackupCodes({ codes, note }: { codes: string[]; note: string }) {
  useEffect(() => {
    void actionClearBackup();
  }, []);
  if (codes.length === 0) return null;
  return (
    <div data-testid="backup-codes">
      <p>{note}</p>
      <ul>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
