"use client";

import { useEffect } from "react";
import { BUILD_SHA } from "@/build-info";
import { PageError } from "@/components/page-error";
import { attemptChunkReload } from "@/lib/chunk-reload";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    attemptChunkReload(error, {
      buildId: BUILD_SHA,
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    });
  }, [error]);

  return (
    <div className="main">
      <PageError reset={reset} />
    </div>
  );
}
