export type IdempotentRecord = {
  id: string;
  orgId: string;
  userId: string;
  token: string;
  hash: string;
};

export type IdempotentClaim =
  | { action: "replay"; id: string }
  | { action: "create" };

/** Same org, same user, same token, same payload replays. A different payload never replays another record. */
export function claimIdempotentSubmit(
  records: IdempotentRecord[],
  query: { orgId: string; userId: string; token: string; hash: string },
): IdempotentClaim {
  const same = records.find(
    (row) =>
      row.orgId === query.orgId &&
      row.userId === query.userId &&
      row.token === query.token &&
      row.hash === query.hash,
  );
  if (same) return { action: "replay", id: same.id };
  return { action: "create" };
}

export function idempotencyLockKey(scope: string, orgId: string, userId: string, token: string) {
  return `${scope}:${orgId}:${userId}:${token}`;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** In-memory stand-in for the database claim. Triple-click keeps one id; a new payload inserts another. */
export function rememberIdempotentSubmit(
  records: IdempotentRecord[],
  query: { orgId: string; userId: string; token: string; hash: string },
  mintId: () => string,
) {
  const claim = claimIdempotentSubmit(records, query);
  if (claim.action === "replay") return claim.id;
  const id = mintId();
  records.push({ ...query, id });
  return id;
}
