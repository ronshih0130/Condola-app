"use client";

import Link from "next/link";

/** Existing zh-TW error page. The title stays 頁面暫時無法載入 on every locale. */
export function PageError({ reset, framed = false }: { reset: () => void; framed?: boolean }) {
  const body = (
    <>
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
    </>
  );
  if (framed) {
    return (
      <main className="card pad" data-testid="page-error" style={{ maxWidth: 480, margin: "48px auto" }}>
        {body}
      </main>
    );
  }
  return (
    <div className="card pad" data-testid="page-error">
      {body}
    </div>
  );
}
