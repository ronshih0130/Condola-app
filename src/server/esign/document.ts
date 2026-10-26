/** Strict JSON only: reject unsupported values instead of silently dropping them. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new Error("Non-finite JSON number");
      return JSON.stringify(item);
    }
    if (typeof item !== "object") throw new Error("Unsupported JSON value");
    if (ancestors.has(item)) throw new Error("Cyclic JSON");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Symbol keys are unsupported");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const parts: string[] = [];
        for (let i = 0; i < item.length; i++) {
          if (!Object.hasOwn(item, i)) throw new Error("Sparse arrays are unsupported");
          parts.push(encode(item[i]));
        }
        return `[${parts.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Plain JSON objects required");
      }
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("JSON accessors are unsupported");
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      }).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy the exact view into an owned ArrayBuffer, including subarray boundaries.
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  const result = await crypto.subtle.digest("SHA-256", owned.buffer);
  return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash the exact bytes displayed, without parsing or re-saving the PDF. */
export async function contractVersionDigest(pdfBytes: Uint8Array): Promise<string> {
  return sha256Hex(pdfBytes);
}

export const GENESIS_HASH = "0".repeat(64);
export type ChainEntry<T = unknown> = {
  prevHash: string;
  event: T;
  hash: string;
};

function requireHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid SHA-256 hash");
}

async function eventHash(prevHash: string, event: unknown): Promise<string> {
  requireHash(prevHash);
  return sha256Hex(new TextEncoder().encode(prevHash + canonicalJson(event)));
}

/**
 * Returns a new array and canonical snapshots. Never edits the input chain.
 * Supply the expected head when crossing a persistence boundary.
 */
export async function appendAudit<T>(
  chain: readonly ChainEntry<T>[],
  event: T,
  expectedHead?: string,
): Promise<ChainEntry<T>[]> {
  if (!(await verifyChain(chain, expectedHead))) throw new Error("Invalid existing chain");
  const prevHash = chain.at(-1)?.hash ?? GENESIS_HASH;
  const snapshot = JSON.parse(canonicalJson(event)) as T;
  const hash = await eventHash(prevHash, snapshot);
  const previous = chain.map((entry) => ({
    prevHash: entry.prevHash,
    event: JSON.parse(canonicalJson(entry.event)) as T,
    hash: entry.hash,
  }));
  return [...previous, { prevHash, event: snapshot, hash }];
}

/**
 * Internal hashes detect edits/reordering. An independently retained head is
 * necessary to detect suffix truncation or complete replacement of a chain.
 */
export async function verifyChain(
  chain: readonly ChainEntry[],
  expectedHead?: string,
): Promise<boolean> {
  try {
    let prev = GENESIS_HASH;
    for (const entry of chain) {
      requireHash(entry.hash);
      if (entry.prevHash !== prev || await eventHash(prev, entry.event) !== entry.hash) return false;
      prev = entry.hash;
    }
    if (expectedHead !== undefined) {
      requireHash(expectedHead);
      return prev === expectedHead;
    }
    return true;
  } catch {
    return false;
  }
}
