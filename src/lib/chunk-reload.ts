/** sessionStorage key for the one automatic reload after a stale chunk 404. */
export function chunkReloadStorageKey(buildId: string) {
  const id = buildId.trim() || "unknown";
  return `condola:chunk-reload:${id}`;
}

export type ChunkReloadStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const CHUNK_FAILURE =
  /ChunkLoadError|Loading chunk [\w./~-]+ failed|Loading CSS chunk [\w./~-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|\/_next\/static\/chunks\/|\/_next\/static\/css\//i;

function resourceUrl(target: unknown) {
  if (!target || typeof target !== "object") return "";
  const element = target as { tagName?: unknown; src?: unknown; href?: unknown };
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag !== "SCRIPT" && tag !== "LINK") return "";
  const src = typeof element.src === "string" ? element.src : "";
  const href = typeof element.href === "string" ? element.href : "";
  return `${src} ${href}`.trim();
}

function collectFailureText(input: unknown, depth: number, seen: Set<object>): string[] {
  if (input == null || depth > 4) return [];
  if (typeof input === "string" || typeof input === "number") return [String(input)];
  if (typeof input !== "object") return [];
  if (seen.has(input)) return [];
  seen.add(input);
  const record = input as { name?: unknown; message?: unknown; filename?: unknown; error?: unknown; reason?: unknown; target?: unknown };
  const parts: string[] = [];
  if (typeof record.name === "string") parts.push(record.name);
  if (typeof record.message === "string") parts.push(record.message);
  if (typeof record.filename === "string") parts.push(record.filename);
  const url = resourceUrl(record.target);
  if (url) parts.push(url);
  if ("error" in record) parts.push(...collectFailureText(record.error, depth + 1, seen));
  if ("reason" in record) parts.push(...collectFailureText(record.reason, depth + 1, seen));
  return parts;
}

/** True for a missing Next chunk: ChunkLoadError, a failed dynamic import, or a /_next/static script or stylesheet. */
export function isChunkLoadFailure(input: unknown) {
  const text = collectFailureText(input, 0, new Set()).join("\n");
  if (!text.trim()) return false;
  return CHUNK_FAILURE.test(text);
}

/**
 * One reload per build id. The id is NEXT_PUBLIC_BUILD_SHA (the same sha /api/version returns).
 * A thrown storage read or write refuses the reload so a broken sessionStorage cannot loop.
 */
export function shouldAutoReload(buildId: string, storage: ChunkReloadStorage) {
  const key = chunkReloadStorageKey(buildId);
  try {
    if (storage.getItem(key) === "1") return false;
  } catch {
    return false;
  }
  try {
    storage.setItem(key, "1");
  } catch {
    return false;
  }
  return true;
}

export type ChunkReloadDeps = {
  buildId: string;
  storage: ChunkReloadStorage;
  reload: () => void;
};

export type ChunkReloadAction = "reloaded" | "blocked" | "ignored";

export function attemptChunkReload(input: unknown, deps: ChunkReloadDeps): ChunkReloadAction {
  if (!isChunkLoadFailure(input)) return "ignored";
  if (!shouldAutoReload(deps.buildId, deps.storage)) return "blocked";
  deps.reload();
  return "reloaded";
}

export type ChunkListener = (event: unknown) => void;

export type ChunkReloadTarget = {
  addEventListener(type: "error", listener: ChunkListener, capture?: boolean): void;
  addEventListener(type: "unhandledrejection", listener: ChunkListener, capture?: boolean): void;
  removeEventListener(type: "error", listener: ChunkListener, capture?: boolean): void;
  removeEventListener(type: "unhandledrejection", listener: ChunkListener, capture?: boolean): void;
};

function preventIfPossible(event: unknown) {
  if (!event || typeof event !== "object" || !("preventDefault" in event)) return;
  const prevent = (event as { preventDefault?: unknown }).preventDefault;
  if (typeof prevent === "function") prevent.call(event);
}

/** window error (capture, so a failed <script> or <link> is included) and unhandledrejection. */
export function installChunkReloadListeners(target: ChunkReloadTarget, deps: ChunkReloadDeps) {
  const onError: ChunkListener = (event) => {
    if (attemptChunkReload(event, deps) === "reloaded") preventIfPossible(event);
  };
  const onRejection: ChunkListener = (event) => {
    const reason = event && typeof event === "object" && "reason" in event ? (event as { reason?: unknown }).reason : event;
    if (attemptChunkReload(reason ?? event, deps) === "reloaded") preventIfPossible(event);
  };
  target.addEventListener("error", onError, true);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError, true);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
