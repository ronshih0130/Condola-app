"use client";

import Link from "next/link";

export default function ManagerError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card pad" data-testid="page-error">
      <h1>頁面暫時無法載入</h1>
      <p>可能是網路不穩，資料都還在。請再試一次。</p>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn pri" type="button" data-testid="page-error-reload" onClick={() => reset()}>
          重新載入
        </button>
        <Link className="btn" href="/" data-testid="page-error-home">
          回到首頁
        </Link>
      </p>
    </div>
  );
}
