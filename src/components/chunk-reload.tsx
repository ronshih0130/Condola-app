"use client";

import { useEffect } from "react";
import { BUILD_SHA } from "@/build-info";
import {
  installChunkReloadListeners,
  installNavigationTracking,
  recoverChunkFailure,
  type ChunkReloadTarget,
  type ClickEventTarget,
  type HistoryLike,
} from "@/lib/chunk-reload";

export function ChunkReloadListener() {
  useEffect(() => {
    const target: ChunkReloadTarget & ClickEventTarget = {
      addEventListener(type, listener, capture) {
        window.addEventListener(type, listener as EventListener, capture);
      },
      removeEventListener(type, listener, capture) {
        window.removeEventListener(type, listener as EventListener, capture);
      },
    };
    const stopErrors = installChunkReloadListeners(target, {
      buildId: BUILD_SHA,
      storage: window.sessionStorage,
      reload: () => recoverChunkFailure(window.location, Date.now()),
    });
    const stopNavigation = installNavigationTracking(target, window.history as HistoryLike, () => window.location.href);
    return () => {
      stopErrors();
      stopNavigation();
    };
  }, []);
  return null;
}
