"use client";

import { useEffect } from "react";
import { BUILD_SHA } from "@/build-info";
import { installChunkReloadListeners, type ChunkReloadTarget } from "@/lib/chunk-reload";

export function ChunkReloadListener() {
  useEffect(() => {
    const target: ChunkReloadTarget = {
      addEventListener(type, listener, capture) {
        window.addEventListener(type, listener as EventListener, capture);
      },
      removeEventListener(type, listener, capture) {
        window.removeEventListener(type, listener as EventListener, capture);
      },
    };
    return installChunkReloadListeners(target, {
      buildId: BUILD_SHA,
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    });
  }, []);
  return null;
}
