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

/** How long a click or history update still counts as the navigation in progress. */
export const NAVIGATION_TARGET_MAX_AGE_MS = 10_000;

type PendingNavigation = { href: string; at: number };

let pendingNavigation: PendingNavigation | null = null;

export function clearNavigationTarget() {
  pendingNavigation = null;
}

export function noteNavigationTarget(href: string, at: number) {
  pendingNavigation = { href, at };
}

/** Same-origin page URL, or null when it is external, not http(s), or already the current document. */
export function appNavigationHref(href: string, baseHref: string) {
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseHref);
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname === base.pathname && url.search === base.search) return null;
  return url.href;
}

export type AnchorLike = {
  href?: string;
  target?: string;
  hasAttribute?: (name: string) => boolean;
};

export type ClickLike = {
  defaultPrevented?: boolean;
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: unknown;
};

function anchorFromClick(event: ClickLike): AnchorLike | null {
  const node = event.target;
  if (!node || typeof node !== "object") return null;
  const closest = (node as { closest?: (selector: string) => unknown }).closest;
  if (typeof closest !== "function") return null;
  const found = closest.call(node, "a");
  if (!found || typeof found !== "object") return null;
  return found as AnchorLike;
}

/** In-app destination of a plain left click, before the client router handles it. */
export function hrefFromLinkClick(event: ClickLike, currentHref: string) {
  if (event.defaultPrevented) return null;
  if (event.button != null && event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = anchorFromClick(event);
  if (!anchor?.href) return null;
  const frame = (anchor.target || "").toLowerCase();
  if (frame && frame !== "_self") return null;
  if (anchor.hasAttribute?.("download")) return null;
  return appNavigationHref(anchor.href, currentHref);
}

export function hrefFromHistoryUrl(url: string | URL | null | undefined, currentHref: string) {
  if (url == null || url === "") return null;
  return appNavigationHref(String(url), currentHref);
}

/** Destination still worth a full load, or null when it is missing, stale, or already current. */
export function navigationTargetHref(currentHref: string, now: number, maxAgeMs = NAVIGATION_TARGET_MAX_AGE_MS) {
  const pending = pendingNavigation;
  if (!pending) return null;
  if (now < pending.at || now - pending.at > maxAgeMs) return null;
  return appNavigationHref(pending.href, currentHref);
}

export type ChunkRecoveryLocation = {
  href: string;
  assign(url: string): void;
  reload(): void;
};

/** Full-page load of the in-progress destination. Reloads the current page when that URL is unknown. */
export function recoverChunkFailure(location: ChunkRecoveryLocation, now: number) {
  const target = navigationTargetHref(location.href, now);
  if (target) location.assign(target);
  else location.reload();
}

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

export type HistoryLike = {
  pushState(state: unknown, title: string, url?: string | URL | null): void;
  replaceState(state: unknown, title: string, url?: string | URL | null): void;
};

export type ClickEventTarget = {
  addEventListener(type: "click", listener: ChunkListener, capture?: boolean): void;
  removeEventListener(type: "click", listener: ChunkListener, capture?: boolean): void;
};

/** Remember the last in-app link click and history update so a failed chunk can load that page. */
export function installNavigationTracking(
  target: ClickEventTarget,
  history: HistoryLike,
  currentHref: () => string,
  now: () => number = () => Date.now(),
) {
  const onClick: ChunkListener = (event) => {
    const href = hrefFromLinkClick(event as ClickLike, currentHref());
    if (href) noteNavigationTarget(href, now());
  };
  target.addEventListener("click", onClick, true);
  const originalPush = history.pushState.bind(history);
  const originalReplace = history.replaceState.bind(history);
  const remember = (url?: string | URL | null) => {
    const href = hrefFromHistoryUrl(url, currentHref());
    if (href) noteNavigationTarget(href, now());
  };
  history.pushState = (state, title, url) => {
    remember(url);
    originalPush(state, title, url);
  };
  history.replaceState = (state, title, url) => {
    remember(url);
    originalReplace(state, title, url);
  };
  return () => {
    target.removeEventListener("click", onClick, true);
    history.pushState = originalPush;
    history.replaceState = originalReplace;
  };
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
