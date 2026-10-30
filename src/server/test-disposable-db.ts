/** Validate a deliberately disposable local test target before any DB access. */
export function disposableDbUrl(url: string | undefined, consent: string | undefined): URL {
  if (consent !== "YES" || !url) throw new Error("An explicitly disposable local test database is required");
  let target: URL;
  try { target = new URL(url); } catch { throw new Error("An explicitly disposable local test database is required"); }
  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !target.port || Number(target.port) < 1 || target.pathname.length < 2 || target.pathname.slice(1).includes("/") ||
      target.search || target.hash) {
    throw new Error("An explicitly disposable local test database is required");
  }
  return target;
}

/** Keep the server and credentials unchanged; only select a named database. */
export function withDatabase(target: URL, database: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error("Invalid test database name");
  const copy = new URL(target.href);
  copy.pathname = `/${database}`;
  return copy.href;
}
