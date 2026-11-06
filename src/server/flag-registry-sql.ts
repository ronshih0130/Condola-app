/**
 * PROP-05 registry guard helpers: a small quote- and comment-aware SQL scanner used by
 * flag-registry.test.ts. It is deliberately strict: a platform_settings seed it cannot
 * understand is reported as unsupported instead of being skipped.
 */
export type Token = { kind: "word" | "string" | "punct" | "other"; text: string };

/** Tokenize SQL, dropping `--` and block comments; keeps single-quoted strings ('' escapes) and "quoted" identifiers. */
export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") {
      // PostgreSQL block comments nest.
      let depth = 1; i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let j = i + 1, text = "";
      for (;;) {
        if (j >= sql.length) throw new Error("unterminated string literal");
        if (sql[j] === "'" && sql[j + 1] === "'") { text += "'"; j += 2; continue; }
        if (sql[j] === "'") break;
        text += sql[j++];
      }
      out.push({ kind: "string", text }); i = j + 1; continue;
    }
    if (c === '"') { const j = sql.indexOf('"', i + 1); out.push({ kind: "word", text: sql.slice(i + 1, j).toLowerCase() }); i = j + 1; continue; }
    if (c === "$") {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/)?.[0];
      if (tag) { const j = sql.indexOf(tag, i + tag.length); out.push({ kind: "string", text: sql.slice(i + tag.length, j < 0 ? sql.length : j) }); i = j < 0 ? sql.length : j + tag.length; continue; }
    }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++; out.push({ kind: "word", text: sql.slice(i, j).toLowerCase() }); i = j; continue; }
    if ("(),;.:".includes(c)) { out.push({ kind: "punct", text: c }); i++; continue; }
    out.push({ kind: "other", text: c }); i++;
  }
  return out;
}

/** Split tokens into statements on top-level `;`. */
export function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = []; let cur: Token[] = [];
  for (const t of tokens) { if (t.kind === "punct" && t.text === ";") { if (cur.length) out.push(cur); cur = []; } else cur.push(t); }
  if (cur.length) out.push(cur);
  return out;
}

export type Seed = { key: string | null; value: Token[]; conflict: "nothing" | "update" | "none"; raw: string };

const isWord = (t: Token | undefined, w: string) => t?.kind === "word" && t.text === w;
const isPunct = (t: Token | undefined, p: string) => t?.kind === "punct" && t.text === p;

/** Find `INSERT INTO [public.]platform_settings (...) VALUES (...)[, (...)] [ON CONFLICT ... DO ...]`. */
export function platformSettingsSeeds(stmt: Token[]): Seed[] | null {
  let i = stmt.findIndex((t, n) => isWord(t, "insert") && isWord(stmt[n + 1], "into"));
  if (i < 0) return null;
  i += 2;
  if (isWord(stmt[i], "public") && isPunct(stmt[i + 1], ".")) i += 2;
  if (!isWord(stmt[i], "platform_settings")) return null;
  i++;
  const raw = stmt.map((t) => (t.kind === "string" ? `'${t.text}'` : t.text)).join(" ");
  if (!isPunct(stmt[i], "(")) throw new Error(`platform_settings insert without a column list: ${raw.slice(0, 120)}`);
  const cols: string[] = [];
  for (i++; stmt[i] && !isPunct(stmt[i], ")"); i++) if (stmt[i].kind === "word") cols.push(stmt[i].text);
  i++;
  if (!isWord(stmt[i], "values")) throw new Error(`unsupported platform_settings seed (not VALUES): ${raw.slice(0, 120)}`);
  i++;
  const tuples: Token[][][] = [];
  while (isPunct(stmt[i], "(")) {
    const fields: Token[][] = [[]]; let depth = 0; i++;
    for (; i < stmt.length; i++) {
      const t = stmt[i];
      if (isPunct(t, "(")) depth++;
      if (isPunct(t, ")")) { if (depth === 0) break; depth--; }
      if (isPunct(t, ",") && depth === 0) { fields.push([]); continue; }
      fields[fields.length - 1].push(t);
    }
    tuples.push(fields); i++;
    if (isPunct(stmt[i], ",")) i++; else break;
  }
  let conflict: Seed["conflict"] = "none";
  const on = stmt.findIndex((t, n) => n >= i && isWord(t, "on") && isWord(stmt[n + 1], "conflict"));
  if (on >= 0) {
    const doAt = stmt.findIndex((t, n) => n > on && isWord(t, "do"));
    conflict = isWord(stmt[doAt + 1], "nothing") ? "nothing" : "update";
  }
  const keyAt = cols.indexOf("key"), valueAt = cols.indexOf("value");
  if (keyAt < 0 || valueAt < 0) throw new Error(`platform_settings insert missing key/value columns: ${raw.slice(0, 120)}`);
  for (const fields of tuples) if (fields.length !== cols.length) throw new Error(`platform_settings tuple/column count mismatch: ${raw.slice(0, 120)}`);
  return tuples.map((fields) => {
    const keyTok = fields[keyAt] ?? [];
    return { key: keyTok.length === 1 && keyTok[0].kind === "string" ? keyTok[0].text : null, value: fields[valueAt] ?? [], conflict, raw };
  });
}

/**
 * A flag seed is a decoded JSON object with an `enabled` key. A value that cannot be decoded
 * as a JSON literal is treated as a flag seed too, so it is reported as unsupported rather
 * than silently skipped (escapes such as \u0065nabled decode before classification).
 */
export function isFlagSeed(seed: Seed): boolean {
  const value = literalJson(seed);
  if (value === undefined) return true;
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "enabled");
}

function literalJson(seed: Seed): unknown {
  const [lit, ...rest] = seed.value;
  if (lit?.kind !== "string") return undefined;
  const tail = rest.map((t) => t.text).join("");
  if (tail !== "" && tail !== "::jsonb" && tail !== "::json") return undefined;
  try { return JSON.parse(lit.text); } catch { return undefined; }
}

/** Only `'<json literal>'[::jsonb]` is accepted for flag seeds. */
export function literalFlagValue(seed: Seed): { enabled?: unknown; allowed_org_ids?: unknown } | null {
  const [lit, ...rest] = seed.value;
  if (lit?.kind !== "string") return null;
  const tail = rest.map((t) => t.text).join("");
  if (tail !== "" && tail !== "::jsonb" && tail !== "::json") return null;
  try { return JSON.parse(lit.text) as { enabled?: unknown; allowed_org_ids?: unknown }; } catch { return null; }
}
