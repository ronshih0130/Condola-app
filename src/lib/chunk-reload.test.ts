import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  NAVIGATION_TARGET_MAX_AGE_MS,
  attemptChunkReload,
  chunkReloadStorageKey,
  clearNavigationTarget,
  hrefFromHistoryUrl,
  hrefFromLinkClick,
  installChunkReloadListeners,
  installNavigationTracking,
  isChunkLoadFailure,
  navigationTargetHref,
  noteNavigationTarget,
  recoverChunkFailure,
  shouldAutoReload,
  type ChunkListener,
  type ChunkReloadStorage,
  type ChunkReloadTarget,
  type ClickEventTarget,
  type HistoryLike,
} from "./chunk-reload";

function memoryStorage(initial?: Record<string, string>): ChunkReloadStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function throwingStorage(method: "getItem" | "setItem"): ChunkReloadStorage {
  return {
    getItem() {
      if (method === "getItem") throw new Error("storage blocked");
      return null;
    },
    setItem() {
      if (method === "setItem") throw new Error("storage blocked");
    },
  };
}

test("detects chunk load failures and ignores ordinary errors", () => {
  const chunk = new Error("Loading chunk 845 failed.\n(error: https://staging.condola.app/_next/static/chunks/845.js)");
  chunk.name = "ChunkLoadError";
  assert.equal(isChunkLoadFailure(chunk), true);
  assert.equal(isChunkLoadFailure({ name: "ChunkLoadError", message: "" }), true);
  assert.equal(isChunkLoadFailure("Loading CSS chunk app/layout failed."), true);
  assert.equal(
    isChunkLoadFailure(new TypeError("Failed to fetch dynamically imported module: https://staging.condola.app/_next/static/chunks/app/m/page.js")),
    true,
  );
  assert.equal(isChunkLoadFailure({ message: "error loading dynamically imported module" }), true);
  assert.equal(isChunkLoadFailure({ name: "TypeError", message: "Importing a module script failed." }), true);
  assert.equal(
    isChunkLoadFailure({
      message: "",
      target: { tagName: "SCRIPT", src: "https://staging.condola.app/_next/static/chunks/webpack.js" },
    }),
    true,
  );
  assert.equal(
    isChunkLoadFailure({
      target: { tagName: "LINK", href: "/_next/static/css/app.css" },
    }),
    true,
  );
  assert.equal(
    isChunkLoadFailure({
      message: "Script error.",
      filename: "https://staging.condola.app/_next/static/chunks/main-app.js",
      error: null,
    }),
    true,
  );
  assert.equal(
    isChunkLoadFailure({ reason: { name: "ChunkLoadError", message: "Loading chunk 12 failed." } }),
    true,
  );

  assert.equal(isChunkLoadFailure(new TypeError("Cannot read properties of undefined (reading 'map')")), false);
  assert.equal(isChunkLoadFailure(new TypeError("Failed to fetch")), false);
  assert.equal(isChunkLoadFailure({ message: "Application error: a client-side exception has occurred" }), false);
  assert.equal(isChunkLoadFailure({ target: { tagName: "SCRIPT", src: "https://example.com/analytics.js" } }), false);
  assert.equal(isChunkLoadFailure({ message: "ok", stack: "at /_next/static/chunks/webpack.js:1:1" }), false);
  assert.equal(isChunkLoadFailure(null), false);
  assert.equal(isChunkLoadFailure(""), false);
});

test("reloads once per build id and then blocks", () => {
  const storage = memoryStorage();
  assert.equal(chunkReloadStorageKey("abc1234"), "condola:chunk-reload:abc1234");
  assert.equal(chunkReloadStorageKey("  "), "condola:chunk-reload:unknown");
  assert.equal(shouldAutoReload("abc1234", storage), true);
  assert.equal(storage.data.get("condola:chunk-reload:abc1234"), "1");
  assert.equal(shouldAutoReload("abc1234", storage), false);
  assert.equal(shouldAutoReload("def5678", storage), true);
  assert.equal(shouldAutoReload("", throwingStorage("getItem")), false);
  assert.equal(shouldAutoReload("abc1234", throwingStorage("setItem")), false);

  let reloads = 0;
  const deps = {
    buildId: "abc1234",
    storage: memoryStorage({ "condola:chunk-reload:abc1234": "1" }),
    reload: () => {
      reloads += 1;
    },
  };
  assert.equal(attemptChunkReload(new Error("Loading chunk 1 failed."), deps), "blocked");
  assert.equal(reloads, 0);

  const fresh = memoryStorage();
  const freshDeps = {
    buildId: "abc1234",
    storage: fresh,
    reload: () => {
      reloads += 1;
    },
  };
  assert.equal(attemptChunkReload({ name: "ChunkLoadError", message: "Loading chunk 9 failed." }, freshDeps), "reloaded");
  assert.equal(attemptChunkReload({ name: "ChunkLoadError", message: "Loading chunk 9 failed." }, freshDeps), "blocked");
  assert.equal(attemptChunkReload(new Error("Failed to fetch"), freshDeps), "ignored");
  assert.equal(reloads, 1);
});

test("window error and unhandledrejection reload once, then stop", () => {
  type Entry = { type: string; capture: boolean; listener: ChunkListener };
  const entries: Entry[] = [];
  const target: ChunkReloadTarget = {
    addEventListener(type, listener, capture) {
      entries.push({ type, capture: Boolean(capture), listener });
    },
    removeEventListener(type, listener, capture) {
      const captureFlag = Boolean(capture);
      const index = entries.findIndex((entry) => entry.type === type && entry.capture === captureFlag && entry.listener === listener);
      if (index >= 0) entries.splice(index, 1);
    },
  };
  let reloads = 0;
  let prevented = 0;
  const remove = installChunkReloadListeners(target, {
    buildId: "build1",
    storage: memoryStorage(),
    reload: () => {
      reloads += 1;
    },
  });
  assert.equal(entries.some((entry) => entry.type === "error" && entry.capture), true);
  assert.equal(entries.some((entry) => entry.type === "unhandledrejection" && !entry.capture), true);

  const errorListener = entries.find((entry) => entry.type === "error")!.listener;
  const rejectionListener = entries.find((entry) => entry.type === "unhandledrejection")!.listener;
  const chunkEvent = {
    message: "Loading chunk 3 failed.",
    preventDefault() {
      prevented += 1;
    },
  };
  errorListener(chunkEvent);
  errorListener(chunkEvent);
  rejectionListener({
    reason: new TypeError("Failed to fetch dynamically imported module: /_next/static/chunks/a.js"),
    preventDefault() {
      prevented += 1;
    },
  });
  rejectionListener({ reason: new Error("Cannot read properties of null") });
  assert.equal(reloads, 1);
  assert.equal(prevented, 1);

  remove();
  assert.equal(entries.length, 0);
});

test("error boundaries reuse the zh-TW page and the reload guard", () => {
  const page = readFileSync(new URL("../components/page-error.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/error.tsx", import.meta.url), "utf8");
  const global = readFileSync(new URL("../app/global-error.tsx", import.meta.url), "utf8");
  const listener = readFileSync(new URL("../components/chunk-reload.tsx", import.meta.url), "utf8");
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

  assert.match(page, /頁面暫時無法載入/);
  assert.match(page, /可能是網路不穩，資料都還在。請再試一次。/);
  assert.match(page, /重新載入/);
  assert.match(page, /回到首頁/);
  assert.equal(page.includes("Application error"), false);
  assert.equal(page.includes("error.message"), false);
  assert.equal(page.includes("收款"), false);
  assert.equal(page.includes("收租"), false);
  assert.equal(page.includes("入帳"), false);

  assert.match(app, /<PageError/);
  assert.match(app, /attemptChunkReload/);
  assert.match(global, /<PageError/);
  assert.match(global, /framed/);
  assert.match(global, /attemptChunkReload/);
  assert.match(global, /lang="zh-Hant-TW"/);
  assert.match(global, /頁面暫時無法載入/);
  assert.equal(global.includes("Application error"), false);
  assert.equal(global.includes("error.message"), false);
  assert.equal(global.includes("error.digest"), false);
  assert.equal(app.includes("error.message"), false);

  assert.match(listener, /installChunkReloadListeners/);
  assert.match(listener, /installNavigationTracking/);
  assert.match(listener, /recoverChunkFailure/);
  assert.match(listener, /BUILD_SHA/);
  assert.match(app, /recoverChunkFailure/);
  assert.match(global, /recoverChunkFailure/);
  assert.match(layout, /<ChunkReloadListener \/>/);
});

const CURRENT = "https://app.condola.app/m";
const DESTINATION = "https://app.condola.app/m/units";

function linkClick(href: string, extra: Record<string, unknown> = {}) {
  return {
    button: 0,
    target: {
      closest: () => ({ href, ...extra }),
    },
  };
}

test("a link click or history update assigns that page, and an unknown target reloads", () => {
  clearNavigationTarget();
  const now = 5_000;
  assert.equal(hrefFromLinkClick(linkClick(DESTINATION), CURRENT), DESTINATION);
  assert.equal(hrefFromLinkClick(linkClick("/m/leases"), CURRENT), "https://app.condola.app/m/leases");
  assert.equal(hrefFromLinkClick({ ...linkClick(DESTINATION), metaKey: true }, CURRENT), null);
  assert.equal(hrefFromLinkClick({ ...linkClick(DESTINATION), button: 1 }, CURRENT), null);
  assert.equal(hrefFromLinkClick({ ...linkClick(DESTINATION), defaultPrevented: true }, CURRENT), null);
  assert.equal(hrefFromLinkClick(linkClick("https://example.com/away"), CURRENT), null);
  assert.equal(hrefFromLinkClick(linkClick(DESTINATION, { target: "_blank" }), CURRENT), null);
  assert.equal(hrefFromLinkClick(linkClick(DESTINATION, { hasAttribute: (name: string) => name === "download" }), CURRENT), null);
  assert.equal(hrefFromLinkClick(linkClick(`${CURRENT}#section`), CURRENT), null);
  assert.equal(hrefFromHistoryUrl("/m/units?floor=2", CURRENT), "https://app.condola.app/m/units?floor=2");
  assert.equal(hrefFromHistoryUrl(null, CURRENT), null);

  noteNavigationTarget(DESTINATION, now);
  const assigned: string[] = [];
  let reloads = 0;
  const location = {
    href: CURRENT,
    assign(url: string) {
      assigned.push(url);
    },
    reload() {
      reloads += 1;
    },
  };
  recoverChunkFailure(location, now);
  assert.deepEqual(assigned, [DESTINATION]);
  assert.equal(reloads, 0);

  clearNavigationTarget();
  recoverChunkFailure(location, now);
  assert.equal(reloads, 1);

  noteNavigationTarget(DESTINATION, now - NAVIGATION_TARGET_MAX_AGE_MS - 1);
  assert.equal(navigationTargetHref(CURRENT, now), null);
  recoverChunkFailure(location, now);
  assert.equal(reloads, 2);

  noteNavigationTarget(CURRENT, now);
  recoverChunkFailure(location, now);
  assert.equal(reloads, 3);
  clearNavigationTarget();
});

test("the one-per-build guard still blocks a second destination load", () => {
  clearNavigationTarget();
  noteNavigationTarget(DESTINATION, 1);
  const assigned: string[] = [];
  let reloads = 0;
  const reload = () =>
    recoverChunkFailure(
      {
        href: CURRENT,
        assign(url: string) {
          assigned.push(url);
        },
        reload() {
          reloads += 1;
        },
      },
      1,
    );
  const deps = { buildId: "abc1234", storage: memoryStorage(), reload };
  assert.equal(attemptChunkReload({ name: "ChunkLoadError", message: "Loading chunk 4 failed." }, deps), "reloaded");
  assert.equal(attemptChunkReload({ name: "ChunkLoadError", message: "Loading chunk 4 failed." }, deps), "blocked");
  assert.deepEqual(assigned, [DESTINATION]);
  assert.equal(reloads, 0);
  clearNavigationTarget();
});

test("click capture and history updates remember the in-app destination", () => {
  clearNavigationTarget();
  let now = 100;
  let href = CURRENT;
  const entries: { type: string; capture: boolean; listener: ChunkListener }[] = [];
  const target: ClickEventTarget = {
    addEventListener(type, listener, capture) {
      entries.push({ type, capture: Boolean(capture), listener });
    },
    removeEventListener(type, listener, capture) {
      const captureFlag = Boolean(capture);
      const index = entries.findIndex((entry) => entry.type === type && entry.capture === captureFlag && entry.listener === listener);
      if (index >= 0) entries.splice(index, 1);
    },
  };
  const history: HistoryLike = {
    pushState(_state, _title, url) {
      if (url) href = new URL(String(url), href).href;
    },
    replaceState(_state, _title, url) {
      if (url) href = new URL(String(url), href).href;
    },
  };
  const stop = installNavigationTracking(target, history, () => href, () => now);
  assert.equal(entries.some((entry) => entry.type === "click" && entry.capture), true);
  history.pushState({}, "", "/m/units");
  assert.equal(navigationTargetHref(CURRENT, now), DESTINATION);
  now += 5;
  history.replaceState({}, "", "/m/leases");
  assert.equal(navigationTargetHref(CURRENT, now), "https://app.condola.app/m/leases");
  entries.find((entry) => entry.type === "click")!.listener(linkClick("https://app.condola.app/t/pay"));
  assert.equal(navigationTargetHref(CURRENT, now), "https://app.condola.app/t/pay");
  stop();
  assert.equal(entries.length, 0);
  history.pushState({}, "", "/m/settings");
  assert.equal(navigationTargetHref(CURRENT, now), "https://app.condola.app/t/pay");
  clearNavigationTarget();
});
