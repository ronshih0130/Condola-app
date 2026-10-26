"use client";

import { useState } from "react";

export function VendorLinkField({ url, copyLabel, copiedLabel }: { url: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fg">
      <input
        className="inp"
        readOnly
        value={url}
        data-testid="vendor-link"
        onFocus={(event) => event.currentTarget.select()}
      />
      <button
        className="btn sm"
        type="button"
        data-testid="vendor-copy"
        style={{ marginTop: 8 }}
        onClick={() => {
          const clipboard = navigator.clipboard;
          if (!clipboard?.writeText) return;
          clipboard.writeText(url).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
