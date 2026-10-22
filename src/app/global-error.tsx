"use client";

import { useEffect } from "react";
import { BUILD_SHA } from "@/build-info";
import { PageError } from "@/components/page-error";
import { attemptChunkReload, recoverChunkFailure } from "@/lib/chunk-reload";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    attemptChunkReload(error, {
      buildId: BUILD_SHA,
      storage: window.sessionStorage,
      reload: () => recoverChunkFailure(window.location, Date.now()),
    });
  }, [error]);

  return (
    <html lang="zh-Hant-TW">
      <head>
        <title>頁面暫時無法載入</title>
      </head>
      <body>
        <PageError reset={reset} framed />
      </body>
    </html>
  );
}
