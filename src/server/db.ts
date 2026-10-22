import { Client, type QueryResultRow } from "pg";
import { cache } from "react";
import { mapDbError } from "./errors";
import { preambleSql, selectConnectionString, type DbRoute } from "./hyperdrive";
import { readEnvChoice, resolveStaffOrg, type OrgEnvironment } from "./org-scope";

function closedSocket(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /socket has been closed|Connection terminated/i.test(message);
}

/** pg's terminate (X) message. Sent once, then the socket is closed. */
const TERMINATE = Buffer.from([88, 0, 0, 0, 4]);

/**
 * Workers close the socket as the request finishes. pg then writes a goodbye
 * and emits `This socket has been closed` once per client. Swallow that, wait
 * until the query that was already awaited has left the connection, and end once.
 */
function guardSocketClose(client: Client) {
  client.on("error", () => {});
  const connection = client.connection as Client["connection"] & { _ending?: boolean };
  const stream = connection.stream;
  stream.on("error", () => {});
  let ending = false;
  connection.end = () => {
    if (ending) return;
    ending = true;
    connection._ending = true;
    const finish = () => {
      try {
        stream.end();
      } catch (error) {
        if (!closedSocket(error)) throw error;
        try {
          stream.destroy();
        } catch {
          // The runtime already closed it.
        }
      }
    };
    try {
      if (!stream.writable) {
        finish();
        return;
      }
      stream.write(TERMINATE, () => {
        try {
          finish();
        } catch {
          // close callback can run after the Worker has dropped the socket
        }
      });
    } catch (error) {
      if (!closedSocket(error)) throw error;
      finish();
    }
  };
}

async function endOnce(client: Client, ended: { current: boolean }) {
  if (ended.current) return;
  ended.current = true;
  const active = (client as Client & { _activeQuery?: { once?: (event: string, fn: () => void) => void } })._activeQuery;
  if (active) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      client.once("drain", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  try {
    await Promise.race([
      client.end(),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
  } catch (error) {
    if (!closedSocket(error)) throw error;
  }
}

/**
 * One database connection for a single operation.
 * Cloudflare Workers close sockets when a request ends, so a module-level Pool
 * (or anything stored on globalThis) hands the next request a dead socket.
 * A read route uses Hyperdrive when that binding exists, and the Supabase
 * `DATABASE_URL` connection otherwise.
 */
let hyperdriveCache: string | null | undefined;
let clientFactory: ((route: DbRoute) => Promise<Client>) | null = null;

export function resetHyperdriveCache() {
  hyperdriveCache = undefined;
  clientFactory = null;
}

/** Unit tests only. A string forces the Hyperdrive branch; null forces DATABASE_URL. */
export function useHyperdriveForTests(url: string | null) {
  hyperdriveCache = url;
}

/** Unit tests only. Returns the same client twice to imitate a pooled connection. */
export function setDbClientFactoryForTests(factory: ((route: DbRoute) => Promise<Client>) | null) {
  clientFactory = factory;
}

async function hyperdriveConnectionString(): Promise<string | undefined> {
  if (hyperdriveCache !== undefined) return hyperdriveCache ?? undefined;
  if (process.env.NEXT_PHASE === "phase-production-build") {
    hyperdriveCache = null;
    return undefined;
  }
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const ctx = await getCloudflareContext({ async: true });
    const url = ctx.env.HYPERDRIVE?.connectionString?.trim() || null;
    hyperdriveCache = url;
    return url ?? undefined;
  } catch {
    hyperdriveCache = null;
    return undefined;
  }
}

async function connectRoute(route: DbRoute): Promise<Client> {
  if (clientFactory) return clientFactory(route);
  const hyperdrive = route === "read" ? await hyperdriveConnectionString() : undefined;
  const client = new Client({
    connectionString: selectConnectionString(route, process.env.DATABASE_URL, hyperdrive),
    connectionTimeoutMillis: 8000,
  });
  client.on("error", () => {});
  await client.connect();
  guardSocketClose(client);
  return client;
}

export async function withClient<T>(fn: (client: Client) => Promise<T>, route: DbRoute = "primary"): Promise<T> {
  const client = await connectRoute(route);
  const ended = { current: false };
  try {
    return await fn(client);
  } finally {
    await endOnce(client, ended);
  }
}

type ReadScope = { orgId: string; environment: OrgEnvironment };

type RequestRead = {
  client: Promise<Client> | null;
  begun: Promise<void> | null;
  scope: { userId: string; orgId: string; environment: OrgEnvironment } | null;
  failed: boolean;
  armed: boolean;
  ended: boolean;
};

const requestRead = cache((): RequestRead => ({
  client: null,
  begun: null,
  scope: null,
  failed: false,
  armed: false,
  ended: false,
}));

/** Real React request cache returns one box. The client build used by unit tests calls through. */
function requestReadBox(): RequestRead | null {
  const first = requestRead();
  return first === requestRead() ? first : null;
}

function armRequestRead(box: RequestRead) {
  if (box.armed) return;
  box.armed = true;
  const finish = async () => {
    if (box.ended) return;
    box.ended = true;
    const client = box.client ? await box.client.catch(() => null) : null;
    if (!client) return;
    try {
      if (box.begun) {
        try {
          await box.begun;
        } catch {
          box.failed = true;
        }
        await client.query(box.failed ? "ROLLBACK" : "COMMIT");
      }
    } catch (error) {
      if (!closedSocket(error)) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The transaction is already closed.
        }
      }
    }
    await endOnce(client, { current: false });
  };
  void registerRequestFinish(finish);
}

async function registerRequestFinish(finish: () => Promise<void>) {
  try {
    const { after } = await import("next/server");
    after(finish);
    return;
  } catch {
    // Not inside a Next request.
  }
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const cloud = await getCloudflareContext({ async: true });
    cloud.ctx.waitUntil(finish());
  } catch {
    // Unit tests do not share a request connection.
  }
}

async function beginRequestRead(userId: string, scope: ReadScope): Promise<boolean> {
  const box = requestReadBox();
  if (!box) return false;
  if (
    box.scope &&
    (box.scope.userId !== userId || box.scope.orgId !== scope.orgId || box.scope.environment !== scope.environment)
  ) {
    return false;
  }
  if (!box.begun) {
    box.scope = { userId, orgId: scope.orgId, environment: scope.environment };
    if (!box.client) {
      box.client = connectRoute("read");
      armRequestRead(box);
    }
    const clientPromise = box.client;
    box.begun = (async () => {
      try {
        const client = await clientPromise;
        await client.query(
          preambleSql({
            userId,
            role: "authenticated",
            pin: { orgId: scope.orgId, environment: scope.environment },
            begin: true,
          }),
        );
      } catch (error) {
        box.failed = true;
        throw error;
      }
    })();
  }
  await box.begun;
  return !box.failed;
}

async function requestReadClient(): Promise<Client | null> {
  const box = requestReadBox();
  if (!box?.begun || !box.client) return null;
  try {
    await box.begun;
  } catch {
    return null;
  }
  if (box.failed) return null;
  return box.client;
}

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  return withClient((client) => client.query<T>(sql, params));
}

export async function many<T extends QueryResultRow>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function one<T extends QueryResultRow>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await many<T>(client, sql, params);
  if (!rows[0]) {
    const { FlowError } = await import("./errors");
    throw new FlowError("errors.notFound");
  }
  return rows[0];
}

export async function maybe<T extends QueryResultRow>(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await many<T>(client, sql, params);
  return rows[0] ?? null;
}

export type TxScope = { orgId: string; environment?: OrgEnvironment } | { pin: false };

async function pinOrg(client: Client, orgId: string, environment: OrgEnvironment) {
  await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [orgId]);
  await client.query(`SELECT set_config('app.env', $1, true)`, [environment]);
}

/** Supabase `DATABASE_URL`. Same claims, pin, and `SET LOCAL ROLE` as before Hyperdrive. */
async function legacyTx<T>(userId: string, fn: (client: Client) => Promise<T>, scope?: TxScope): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      if (scope && "pin" in scope) {
        // Explicitly unpinned: sandbox rows stay hidden, live membership is unchanged.
      } else if (scope && "orgId" in scope) {
        const environment =
          scope.environment ??
          (
            await client.query<{ environment: OrgEnvironment }>(
              `SELECT environment::text AS environment FROM organizations WHERE id = $1`,
              [scope.orgId],
            )
          ).rows[0]?.environment ??
          "live";
        await pinOrg(client, scope.orgId, environment);
      } else {
        const choice = await readEnvChoice();
        if (choice) {
          const firm = await resolveStaffOrg(client, userId, choice.preferred, choice.environment);
          if (firm) await pinOrg(client, firm.orgId, firm.environment);
        }
      }
      await client.query("SET LOCAL ROLE authenticated");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDbError(error);
    }
  });
}

async function lookupPin(
  userId: string,
  scope?: TxScope,
): Promise<{ orgId: string; environment: OrgEnvironment } | undefined> {
  if (!scope || "pin" in scope) return undefined;
  if ("orgId" in scope && scope.environment) return { orgId: scope.orgId, environment: scope.environment };
  if ("orgId" in scope) {
    return withClient(async (client) => {
      const environment =
        (
          await client.query<{ environment: OrgEnvironment }>(
            `SELECT environment::text AS environment FROM organizations WHERE id = $1`,
            [scope.orgId],
          )
        ).rows[0]?.environment ?? "live";
      return { orgId: scope.orgId, environment };
    });
  }
  const choice = await readEnvChoice();
  if (!choice) return undefined;
  return withClient(async (client) => {
    const firm = await resolveStaffOrg(client, userId, choice.preferred, choice.environment);
    return firm ? { orgId: firm.orgId, environment: firm.environment } : undefined;
  });
}

async function hyperdriveTx<T>(userId: string, fn: (client: Client) => Promise<T>, scope?: TxScope): Promise<T> {
  const pin = await lookupPin(userId, scope);
  if (pin) {
    const shared = await beginRequestRead(userId, pin);
    if (shared) {
      const client = await requestReadClient();
      if (client) {
        try {
          return await fn(client);
        } catch (error) {
          const box = requestReadBox();
          if (box) box.failed = true;
          throw mapDbError(error);
        }
      }
    }
  }
  return withClient(async (client) => {
    try {
      await client.query(preambleSql({ userId, role: "authenticated", pin, begin: true }));
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDbError(error);
    }
  }, "read");
}

/** Run as the signed-in persona so Postgres RLS applies. */
export async function tx<T>(userId: string, fn: (client: Client) => Promise<T>, scope?: TxScope): Promise<T> {
  if (await hyperdriveConnectionString()) return hyperdriveTx(userId, fn, scope);
  return legacyTx(userId, fn, scope);
}

/**
 * Schema note: signing, portal-user provisioning, demo notifications and the
 * try-out flag run as service_role (BYPASSRLS), matching the schema comment
 * that those flows are server-side. Callers must authorize first.
 */
export async function svc<T>(userId: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query(preambleSql({ userId, role: "service_role", begin: true }));
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapDbError(error);
    }
  });
}
