import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { isFlagSeed, platformSettingsSeeds, statements, tokenize } from "./flag-registry-sql";

// Phase 0 guard (ADR-113 option A, static key check only). Two directions:
//   1. a flag key read through a literal from organizations.feature_flags or platform_settings,
//      in non-test src or in a migration, must be a key of ops/flags.yaml;
//   2. a key of ops/flags.yaml must be referenced by non-test src or by a migration.
// Today's known drift is listed below with one reason each. The list is pinned by count and
// sha256 (EXCEPTIONS_PIN): it can shrink, it cannot grow, and an entry that stops being true fails.
// This file never reads expires_at and does not judge flag values or evaluation rules
// (flag-registry.test.ts covers migration seeds; scripts/flag-expiry-policy.cjs covers expiry).

/** Keys read at runtime that have no ops/flags.yaml entry of their own. owner: Ron/CEO (ADR-113). */
const UNREGISTERED_OK = new Map<string, string>([
  // owner: Ron/CEO (ADR-113 Q3) — real switches with no registry entry on this tree
  ["brand_v2", "org opt-in read by src/server/brand-v2.ts (env BRAND_V2 OR this key); not in the registry"],
  ["vendor_dispatch", "org key read by repair-approval.ts and migration 20261030150200 (false = off, absent = on); not in the registry"],
  ["go_live_lock", "platform_settings row read by org-scope.ts and platform.ts; not in the registry"],
  ["design_partner_consent_gate", "three-state platform value + org override read by partner-consent.ts and staff-profile.ts; not in the registry"],
  ["esign_disposal_enabled", "platform_settings row read by migration 20261030151600 (e-sign retention); not in the registry"],
  ["ID_PURGE_ENABLED", "platform_settings row read by migration 20261031100203 (ID retention purge); not in the registry"],
  // owner: Ron/CEO (ADR-113 Q8) — a platform_settings row that holds data, not an on/off switch
  ["partner_consent_approved_agreements", "not a flag: approved-agreement hashes read by migration 20261106200000; needs a registry record type or a permanent exclusion"],
  ["id_documents.max_retention_days_after_close", "not a flag: ID retention length (days) read by migrations 20261018120000 and 20261030151200; same decision as above"],
  ["id_documents.org_retention_locked", "platform_settings lock read by migration 20261030151200 (ID purge dry-run guard); not in the registry"],
]);

/**
 * Name drift: the registry entry is the env-style name, the database key is different.
 * org key -> registry key. owner: Ron/CEO (ADR-113 Q5). The test also checks that the registry
 * entry's own text names the org key, so a wrong pairing cannot be parked here.
 */
type Drift = { registry: string; reason: string };
const NAME_DRIFT_OK = new Map<string, Drift>([
  ["esign", { registry: "ESIGN_ENABLED", reason: "registry lists the Worker var; code reads feature_flags.esign (src/server/esign/access.ts)" }],
  ["tenant_signed_pdf", { registry: "TENANT_SIGNED_PDF_ENABLED", reason: "registry lists the Worker var; code and migrations read tenant_signed_pdf" }],
  ["import_error_details", { registry: "IMPORT_ERROR_DETAILS_ENABLED", reason: "registry lists the Worker var; src/server/import-feature.ts reads flags.import_error_details" }],
  ["paper_lease_versions", { registry: "PAPER_LEASE_VERSIONS_ENABLED", reason: "registry lists the Worker var; paper-lease-versions-rules.ts reads featureFlags.paper_lease_versions" }],
]);

/** Registry keys with no reference in non-test src or migrations. owner: Ron/CEO (ADR-113 Q4). Empty today. */
const UNREFERENCED_OK = new Map<string, string>();

/** Fixed at main 1e0a8ab. `max` never rises; lower `count` and replace `sha256` when an exception is removed. */
const EXCEPTIONS_PIN = { max: 13, count: 13, sha256: "25b2e423edcdd9d51f89507cefcf25bdf2ba8f9d15d35d51c0d4306cddc3d521" };

type Exceptions = { unregistered: Map<string, string>; drift: Map<string, Drift>; unreferenced: Map<string, string> };

export function exceptionIds(ex: Exceptions): string[] {
  return [
    ...[...ex.unregistered.keys()].map((k) => `unregistered:${k}`),
    ...[...ex.drift].map(([k, d]) => `drift:${k}->${d.registry}`),
    ...[...ex.unreferenced.keys()].map((k) => `unreferenced:${k}`),
  ].sort();
}
export function exceptionPinProblems(ex: Exceptions, pin: { max: number; count: number; sha256: string }): string[] {
  const ids = exceptionIds(ex);
  if (pin.count > pin.max) return [`pinned exception count ${pin.count} is above the original ${pin.max}: the list may only shrink`];
  if (ids.length > pin.count) return [`${ids.length} exceptions, pinned ${pin.count}: adding an exception is not allowed — register the flag in ops/flags.yaml (owner: Ron/CEO)`];
  if (ids.length < pin.count) return [`${ids.length} exceptions, pinned ${pin.count}: after removing an exception lower EXCEPTIONS_PIN.count and update its sha256`];
  if (createHash("sha256").update(ids.join("\n")).digest("hex") !== pin.sha256) return ["exception list does not match the pinned sha256: entries may be removed, never added or swapped"];
  return [];
}

// ---------------------------------------------------------------------------------------------
// SQL lexer. Handles -- and nested block comments, '' strings, E'' escape strings, U&'' strings,
// dollar-quoted strings, "quoted identifiers" and $n parameters. It never throws: an unterminated
// literal runs to the end of the input.
// ---------------------------------------------------------------------------------------------
export type Tok =
  | { t: "word"; v: string } // unquoted identifier or keyword, lower-cased
  | { t: "qid"; v: string } // "quoted identifier", exact case
  | { t: "str"; v: string } // decoded string literal
  | { t: "op"; v: string }
  | { t: "param"; v: string };

function decodeEscapes(body: string): string {
  return body.replace(/\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[0-7]{1,3}|[\s\S])/g, (_, e: string) => {
    if (e[0] === "x" && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if ((e[0] === "u" || e[0] === "U") && e.length > 1) return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCodePoint(parseInt(e, 8));
    return ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
  });
}

export function lexSql(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const quoted = (start: number, escapes: boolean): { text: string; end: number } => {
    let j = start + 1, raw = "";
    while (j < sql.length) {
      if (escapes && sql[j] === "\\" && j + 1 < sql.length) { raw += sql[j] + sql[j + 1]; j += 2; continue; }
      if (sql[j] === "'" && sql[j + 1] === "'") { raw += "'"; j += 2; continue; }
      if (sql[j] === "'") break;
      raw += sql[j++];
    }
    return { text: escapes ? decodeEscapes(raw) : raw, end: j + 1 };
  };
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1; i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
      continue;
    }
    if ((c === "E" || c === "e") && sql[i + 1] === "'") { const q = quoted(i + 1, true); out.push({ t: "str", v: q.text }); i = q.end; continue; }
    if ((c === "U" || c === "u") && sql[i + 1] === "&" && sql[i + 2] === "'") { const q = quoted(i + 2, false); out.push({ t: "str", v: q.text.replace(/\\([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16))) }); i = q.end; continue; }
    if (c === "'") { const q = quoted(i, false); out.push({ t: "str", v: q.text }); i = q.end; continue; }
    if (c === '"') {
      let j = i + 1, text = "";
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { text += '"'; j += 2; continue; }
        if (sql[j] === '"') break;
        text += sql[j++];
      }
      out.push({ t: "qid", v: text }); i = j + 1; continue;
    }
    if (c === "$") {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const body = sql.slice(i + tag.length, end < 0 ? sql.length : end);
        // A dollar-quoted body is either a short literal value or code (function / DO body) to read.
        if (/^[A-Za-z0-9_]*$/.test(body)) out.push({ t: "str", v: body });
        else out.push({ t: "op", v: "$body(" }, ...lexSql(body), { t: "op", v: ")$body" });
        i = end < 0 ? sql.length : end + tag.length; continue;
      }
      const param = sql.slice(i).match(/^\$\d+/)?.[0];
      if (param) { out.push({ t: "param", v: param }); i += param.length; continue; }
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      out.push({ t: "word", v: sql.slice(i, j).toLowerCase() }); i = j; continue;
    }
    const op = ["#>>", "->>", "#>", "->", "@>", "||", "::", "<>", "!=", "<=", ">="].find((o) => sql.startsWith(o, i)) ?? c;
    out.push({ t: "op", v: op }); i += op.length;
  }
  return out;
}

/** Stands for a `${...}` / non-literal operand when TypeScript text is read as SQL; a literal containing it is not a literal key. */
const DYN = "\uE000";
const ALIAS_STOP = new Set(["where", "on", "in", "for", "set", "join", "left", "right", "full", "inner", "cross", "natural", "using", "values", "order", "group", "limit", "returning", "do", "is", "and", "or", "as", "union", "select", "from", "having", "window", "offset", "fetch", "lateral", "not", "then", "else", "end", "loop", "into", "when"]);
const isOp = (t: Tok | undefined, v: string) => t?.t === "op" && t.v === v;
const isName = (t: Tok | undefined, v: string) => (t?.t === "word" || t?.t === "qid") && t.v === v;

/**
 * Flag keys read through a literal key in SQL text.
 *   feature_flags -> 'k' | ->> 'k' | ? 'k' | #> '{k,..}' | #>> '{k,..}' | @> '{"k":..}'
 *     (also "feature_flags", parenthesised operands, any qualifier)
 *   platform_settings [alias] ... [alias.]key = 'k' | 'k' = [alias.]key | key IN ('a','b')
 *     | key = ANY (ARRAY['a','b'])    — same statement; an unqualified key must sit in the same
 *     query level (parenthesis group) as the platform_settings reference.
 * NOT extracted (known limits): keys passed as a parameter (key = $2), built by concatenation
 * ('line_' || persona || '_portal'), chosen by CASE, or handed to a helper function
 * (app.b014_flag_on(org, 'k')). Direction 2 still ties those to the registry.
 */
export function sqlFlagKeys(sql: string): Set<string> {
  const keys = new Set<string>();
  const toks = lexSql(sql);
  const str = (n: number): string | null => { const t = toks[n]; return t?.t === "str" && !t.v.includes(DYN) ? t.v : null; };
  /** A literal that is the whole operand: not glued to a neighbour with ||. */
  const wholeStr = (n: number): string | null => (str(n) !== null && !isOp(toks[n - 1], "||") && !isOp(toks[n + 1], "||") ? str(n) : null);

  // feature_flags <json operator> literal
  for (let n = 0; n < toks.length; n++) {
    if (!isName(toks[n], "feature_flags")) continue;
    let m = n + 1;
    while (isOp(toks[m], ")")) m++;
    const op = toks[m]?.t === "op" ? toks[m].v : "";
    if (!["->", "->>", "?", "#>", "#>>", "@>"].includes(op)) continue;
    m++;
    while (isOp(toks[m], "(")) m++;
    const lit = wholeStr(m);
    if (lit === null) continue;
    if (op === "->" || op === "->>" || op === "?") keys.add(lit);
    else if (op === "#>" || op === "#>>") { const first = lit.match(/^\{\s*"?([^",}\s]+)"?/)?.[1]; if (first) keys.add(first); }
    else { try { const o: unknown = JSON.parse(lit); if (o && typeof o === "object" && !Array.isArray(o)) for (const k of Object.keys(o)) keys.add(k); } catch { /* not a JSON literal */ } }
  }

  // platform_settings ... key = literal, one statement at a time
  let start = 0;
  for (let end = 0; end <= toks.length; end++) {
    if (end < toks.length && !isOp(toks[end], ";")) continue;
    const s = toks.slice(start, end);
    start = end + 1;
    const refs = s.flatMap((t, n) => (isName(t, "platform_settings") && !isOp(s[n + 1], ".") ? [n] : []));
    if (!refs.length) continue;
    const depth: number[] = []; // for each token, the index of its enclosing "(" (or -1)
    const stack: number[] = [];
    s.forEach((t, n) => {
      if (t.t === "op" && (t.v === ")" || t.v === ")$body")) stack.pop();
      depth[n] = stack[stack.length - 1] ?? -1;
      if (t.t === "op" && (t.v === "(" || t.v === "$body(")) stack.push(n);
    });
    const enclosing = (n: number): number[] => { const out: number[] = []; for (let g = depth[n]; g !== undefined && g >= 0; g = depth[g]) out.push(g); out.push(-1); return out; };
    const aliases = new Set<string>(["platform_settings"]);
    for (const r of refs) {
      const a = isName(s[r + 1], "as") ? s[r + 2] : s[r + 1];
      if (a && (a.t === "qid" || (a.t === "word" && !ALIAS_STOP.has(a.v)))) aliases.add(a.v);
    }
    const sstr = (n: number): string | null => { const t = s[n]; return t?.t === "str" && !t.v.includes(DYN) && !isOp(s[n - 1], "||") && !isOp(s[n + 1], "||") ? t.v : null; };
    for (let n = 0; n < s.length; n++) {
      if (!isName(s[n], "key")) continue;
      const qualified = isOp(s[n - 1], ".");
      const first = qualified ? n - 2 : n;
      if (qualified) { const q = s[first]; if (!(q?.t === "word" || q?.t === "qid") || !aliases.has(q.v)) continue; }
      else if (!refs.some((r) => enclosing(n).includes(depth[r]))) continue;
      // `feature_flags->f.key='true'` compares the JSON value: a key that is a JSON operand is not a filter.
      if (["->", "->>", "#>", "#>>"].some((o) => isOp(s[first - 1], o))) continue;
      if (isOp(s[n + 1], "=")) {
        const lit = sstr(n + 2);
        if (lit !== null) keys.add(lit);
        else if (isName(s[n + 2], "any") || isName(s[n + 2], "some")) {
          for (let m = n + 3; m < s.length && !isOp(s[m], ";") && !(isOp(s[m], ")") && depth[m] === depth[n + 3]); m++) { const v = sstr(m); if (v !== null) keys.add(v); }
        }
      }
      if (isOp(s[first - 1], "=")) { const lit = sstr(first - 2); if (lit !== null) keys.add(lit); }
      if (isName(s[n + 1], "in") && isOp(s[n + 2], "(")) {
        for (let m = n + 3; m < s.length && !isOp(s[m], ")"); m++) { const v = sstr(m); if (v !== null) keys.add(v); }
      }
    }
  }
  return keys;
}

/** Every string literal in SQL text, decoded (used only for direction 2). */
export function sqlStringLiterals(sql: string): Set<string> {
  return new Set(lexSql(sql).flatMap((t) => (t.t === "str" && !t.v.includes(DYN) ? [t.v] : [])));
}

// ---------------------------------------------------------------------------------------------
// TypeScript side: the compiler's own parser, so comments are never read and literals are decoded.
// ---------------------------------------------------------------------------------------------
const FLAG_NAMES = new Set(["feature_flags", "featureFlags"]);
/** Names accepted inside the explicit cast `(<name> as Record<string, unknown>).key`. */
const CAST_NAMES = new Set(["feature_flags", "featureFlags", "flags", "orgFlags"]);

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}
function namedFlags(e: ts.Expression, names: Set<string>): boolean {
  const u = unwrap(e);
  return (ts.isIdentifier(u) && names.has(u.text)) || (ts.isPropertyAccessExpression(u) && names.has(u.name.text))
    || (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression) && names.has(u.argumentExpression.text));
}
/** `row.feature_flags`, `featureFlags`, `(x.feature_flags as T)`, or `(flags as Record<string, unknown>)`. */
function isFlagReceiver(e: ts.Expression): boolean {
  if (namedFlags(e, FLAG_NAMES)) return true;
  let inner = e;
  while (ts.isParenthesizedExpression(inner) || ts.isNonNullExpression(inner)) inner = inner.expression;
  return ts.isAsExpression(inner) && /^Record<string,\s*unknown>$/.test(inner.type.getText()) && namedFlags(inner.expression, CAST_NAMES);
}
/** Text of a literal or of a `+` chain / template, with `${...}` and non-literal operands replaced by a parameter. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => ` ${DYN} ${s.literal.text}`).join("");
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = literalText(node.left), r = literalText(node.right);
    return l === null && r === null ? null : `${l ?? ` ${DYN} `}${r ?? ` ${DYN} `}`;
  }
  return null;
}

type TsScan = { keys: Set<string>; literals: Set<string>; envReads: Set<string> };

/**
 * Flag keys read in a TypeScript file.
 *   SQL inside string / template literals (and `+` chains of them): the SQL forms above.
 *   recv.k | recv?.k | recv["k"] | recv?.[`k`] | const { k } = recv, where recv is a value named
 *     feature_flags / featureFlags (identifier or property), optionally cast, or the explicit cast
 *     (flags as Record<string, unknown>).
 * NOT extracted (known limits): a bare local such as `flags.k` or `f.k` without that cast (too
 * ambiguous: many unrelated objects are called flags), and computed keys (recv[key]).
 */
export function scanTs(source: string, fileName = "x.tsx"): TsScan {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: TsScan = { keys: new Set(), literals: new Set(), envReads: new Set() };
  const sql = (text: string) => {
    if (/feature_flags|platform_settings/i.test(text)) for (const k of sqlFlagKeys(text)) out.keys.add(k);
    if (text.includes("'")) for (const s of sqlStringLiterals(text)) out.literals.add(s);
  };
  const isEnv = (e: ts.Expression) => { const u = unwrap(e); return (ts.isIdentifier(u) && u.text === "env") || (ts.isPropertyAccessExpression(u) && u.name.text === "env"); };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) { out.literals.add(node.text); sql(node.text); }
    else if (ts.isTemplateExpression(node)) sql(literalText(node) ?? "");
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) { const t = literalText(node); if (t !== null) sql(t); }

    if (ts.isPropertyAccessExpression(node)) {
      const called = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (isFlagReceiver(node.expression) && !called && !ts.isPrivateIdentifier(node.name)) out.keys.add(node.name.text);
      if (isEnv(node.expression)) out.envReads.add(node.name.text);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      if (isFlagReceiver(node.expression)) out.keys.add(node.argumentExpression.text);
      if (isEnv(node.expression)) out.envReads.add(node.argumentExpression.text);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isFlagReceiver(node.initializer)) {
      for (const el of node.name.elements) {
        const name = el.propertyName ?? el.name;
        if (!el.dotDotDotToken && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) out.keys.add(name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Keys seeded into platform_settings as flags by a migration (existing PROP-05 scanner). */
function seededFlagKeys(sql: string): string[] {
  try {
    return statements(tokenize(sql)).flatMap((s) => platformSettingsSeeds(s) ?? []).filter(isFlagSeed).flatMap((s) => (s.key ? [s.key] : []));
  } catch { return []; } // flag-registry.test.ts owns the strict reading of seeds
}

/** Top-level keys under `flags:` with the text of each entry. */
export function registryEntries(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = yaml.slice(yaml.search(/^flags:\s*$/m));
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_]+):\s*$/gm)];
  heads.forEach((h, n) => {
    assert.ok(!out.has(h[1]), `ops/flags.yaml: duplicate key ${h[1]}`);
    out.set(h[1], body.slice(h.index, heads[n + 1]?.index ?? body.length));
  });
  return out;
}

type Source = { file: string; kind: "sql" | "ts"; text: string };
type Scanned = { file: string; keys: Set<string>; mentions: Set<string> };

export function scanSource(s: Source): Scanned {
  if (s.kind === "sql") return { file: s.file, keys: sqlFlagKeys(s.text), mentions: new Set([...sqlStringLiterals(s.text), ...seededFlagKeys(s.text)]) };
  const r = scanTs(s.text, s.file);
  return { file: s.file, keys: r.keys, mentions: new Set([...r.literals, ...r.envReads]) };
}

/** All findings for one tree; pure, so the self-tests below can drive it with fixtures. */
export function flagKeyViolations(registry: Map<string, string>, sources: Source[], ex: Exceptions): string[] {
  const out: string[] = [];
  const scanned = sources.map(scanSource);
  const usedIn = new Map<string, string[]>();
  for (const s of scanned) for (const k of s.keys) usedIn.set(k, [...(usedIn.get(k) ?? []), s.file]);
  const mentioned = new Set(scanned.flatMap((s) => [...s.mentions]));

  // Direction 1: read but not registered.
  for (const [key, files] of [...usedIn].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (registry.has(key) || ex.unregistered.has(key) || ex.drift.has(key)) continue;
    out.push(`flag key "${key}" is read in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` (+${files.length - 3} more)` : ""} but is not in ops/flags.yaml — register it (owner and expiry are set by Ron/CEO)`);
  }
  // Direction 2: registered but referenced nowhere.
  for (const key of registry.keys()) {
    if (usedIn.has(key) || mentioned.has(key)) {
      if (ex.unreferenced.has(key)) out.push(`stale exception: registry key "${key}" is referenced again — remove it from UNREFERENCED_OK`);
      continue;
    }
    if (!ex.unreferenced.has(key)) out.push(`ops/flags.yaml key "${key}" is not referenced by any non-test src file or migration — remove it or record why it is reserved`);
  }
  // Exceptions must stay true.
  for (const key of ex.unregistered.keys()) {
    if (registry.has(key)) out.push(`stale exception: "${key}" is now in ops/flags.yaml — remove it from UNREGISTERED_OK`);
    else if (!usedIn.has(key)) out.push(`stale exception: "${key}" is no longer read anywhere — remove it from UNREGISTERED_OK`);
  }
  for (const [key, d] of ex.drift) {
    const entry = registry.get(d.registry);
    if (registry.has(key)) out.push(`stale exception: "${key}" is now in ops/flags.yaml — remove it from NAME_DRIFT_OK`);
    else if (!usedIn.has(key)) out.push(`stale exception: "${key}" is no longer read anywhere — remove it from NAME_DRIFT_OK`);
    if (entry === undefined) out.push(`name drift "${key}" points at registry key "${d.registry}", which is not in ops/flags.yaml`);
    else if (!entry.split(/[^A-Za-z0-9_.]+/).includes(`organizations.feature_flags.${key}`)) out.push(`name drift "${key}": registry entry "${d.registry}" does not name organizations.feature_flags.${key}`);
  }
  for (const key of ex.unreferenced.keys()) if (!registry.has(key)) out.push(`stale exception: "${key}" is not in ops/flags.yaml — remove it from UNREFERENCED_OK`);
  return out;
}

const root = fileURLToPath(new URL("../..", import.meta.url));
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
function treeSources(): Source[] {
  const code = walk(join(root, "src")).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f));
  const sql = readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => join(root, "supabase/migrations", f));
  return [
    ...code.map((f) => ({ file: relative(root, f), kind: "ts" as const, text: readFileSync(f, "utf8") })),
    ...sql.map((f) => ({ file: relative(root, f), kind: "sql" as const, text: readFileSync(f, "utf8") })),
  ];
}
const REAL: Exceptions = { unregistered: UNREGISTERED_OK, drift: NAME_DRIFT_OK, unreferenced: UNREFERENCED_OK };

test("flag keys read in src and migrations match ops/flags.yaml, apart from the pinned exceptions", () => {
  const registry = registryEntries(readFileSync(join(root, "ops/flags.yaml"), "utf8"));
  const sources = treeSources();
  assert.ok(registry.size >= 50, `expected the registry to parse (got ${registry.size} keys)`);
  assert.ok(sources.length > 200, "expected src and migrations to be found");
  const used = new Set(sources.flatMap((s) => [...scanSource(s).keys]));
  assert.ok(used.size >= 40, `expected the extractor to find the existing flag reads (got ${used.size})`);
  for (const reason of [...UNREGISTERED_OK.values(), ...UNREFERENCED_OK.values(), ...[...NAME_DRIFT_OK.values()].map((d) => d.reason)]) {
    assert.ok(reason.trim().length > 10, "every exception needs a reason");
  }
  const violations = flagKeyViolations(registry, sources, REAL);
  assert.deepEqual(violations, [], `flag registry drift (ADR-113):\n${violations.join("\n")}`);
});

test("the exception list is pinned: it may shrink, it may not grow", () => {
  assert.deepEqual(exceptionPinProblems(REAL, EXCEPTIONS_PIN), [], exceptionIds(REAL).join("\n"));
  const overlap = [...UNREGISTERED_OK.keys()].filter((k) => NAME_DRIFT_OK.has(k));
  assert.deepEqual(overlap, [], "a key may be listed once");
});

const sqlKeys = (sql: string) => [...sqlFlagKeys(sql)].sort();
const tsKeys = (src: string) => [...scanTs(src).keys].sort();

test("self-test: SQL lexer — escape strings, dollar quotes, quoted identifiers, comments", () => {
  // r1 finding 3: the escaped quote does not end the string, so `--` is not a comment start
  assert.deepEqual(lexSql(String.raw`SELECT E'\'--'; SELECT 1`).map((t) => t.v), ["select", "'--", ";", "select", "1"]);
  assert.deepEqual(sqlKeys(String.raw`SELECT E'\'--'; SELECT feature_flags->'after_escape' FROM organizations;`), ["after_escape"]);
  assert.deepEqual(lexSql(String.raw`SELECT 'a\', E'b\\', 'it''s', E'\x41\101B', U&'d\0061t'`).filter((t) => t.t === "str").map((t) => t.v), ["a\\", "b\\", "it's", "AAB", "dat"]);
  assert.deepEqual(lexSql(`"Feature_Flags" "a""b" plain`), [{ t: "qid", v: "Feature_Flags" }, { t: "qid", v: 'a"b' }, { t: "word", v: "plain" }]);
  assert.deepEqual(lexSql("a -- x 'y\n/* b /* c */ 'd' */ e").map((t) => t.v), ["a", "e"]);
  assert.deepEqual(lexSql("key = $1 AND v = $tag$lit$tag$").map((t) => `${t.t}:${t.v}`), ["word:key", "op:=", "param:$1", "word:and", "word:v", "op:=", "str:lit"]);
  // a function body is code: comments inside it are dropped, reads inside it are found
  assert.deepEqual(sqlKeys(`CREATE FUNCTION f() RETURNS bool LANGUAGE sql AS $fn$ -- feature_flags->'ghost'\n SELECT o.feature_flags->'in_body'='true'::jsonb FROM organizations o $fn$;`), ["in_body"]);
  assert.deepEqual(lexSql("SELECT 'never closed").map((t) => t.v), ["select", "never closed"]);
});

test("self-test: SQL extractor reads the forms used in this repo and the r1 examples", () => {
  assert.deepEqual(sqlKeys(`SELECT 1 FROM organizations o JOIN platform_settings p ON p.key='bank_matching'
    WHERE o.feature_flags->'bank_matching'='true'::jsonb AND coalesce(o.feature_flags ->> 'vendor_dispatch','') IS DISTINCT FROM 'false'`), ["bank_matching", "vendor_dispatch"]);
  assert.deepEqual(sqlKeys(`SELECT (feature_flags->'line_dispatch_push')='true'::jsonb, (o.feature_flags)->'esign' FROM public.organizations`), ["esign", "line_dispatch_push"]);
  // r1 finding 5: quoted identifier, and the literal on the left of the comparison
  assert.deepEqual(sqlKeys(`SELECT "feature_flags"->'new_flag', o."feature_flags" ->> E'esc\\u0061ped' FROM organizations o`), ["escaped", "new_flag"]);
  assert.deepEqual(sqlKeys(`SELECT value FROM platform_settings WHERE 'new_flag' = key`), ["new_flag"]);
  assert.deepEqual(sqlKeys(`SELECT value FROM "platform_settings" AS "S" WHERE 'left_q' = "S"."key" OR "S".key = 'right_q'`), ["left_q", "right_q"]);
  assert.deepEqual(sqlKeys(`SELECT (SELECT value FROM public.platform_settings WHERE key = 'go_live_lock'), 1`), ["go_live_lock"]);
  assert.deepEqual(sqlKeys(`PERFORM 1 FROM public.platform_settings s WHERE s.key = 'esign_disposal_enabled' AND s.value = 'true'::jsonb;`), ["esign_disposal_enabled"]);
  assert.deepEqual(sqlKeys(`SELECT key FROM platform_settings WHERE key IN ('company_profile_edit','design_partner_consent_gate') ORDER BY key`), ["company_profile_edit", "design_partner_consent_gate"]);
  assert.deepEqual(sqlKeys(`SELECT 1 FROM platform_settings f WHERE f.key = ANY (ARRAY['any_a','any_b'])`), ["any_a", "any_b"]);
  assert.deepEqual(sqlKeys(`UPDATE public.platform_settings SET value='{}' WHERE platform_settings.key='INVITE_RESEND_RESULTS';`), ["INVITE_RESEND_RESULTS"]);
  assert.deepEqual(sqlKeys(`SELECT feature_flags ? 'q_key', feature_flags #>> '{path_key,inner}', feature_flags @> '{"contained_key":true}' FROM organizations`), ["contained_key", "path_key", "q_key"]);
  assert.deepEqual(sqlKeys(`SELECT 1 FROM organizations WHERE feature_flags->'constructor'='true'::jsonb`), ["constructor"]);
});

test("self-test: SQL extractor ignores comments, other tables' key columns, values and built keys", () => {
  assert.deepEqual(sqlKeys(`-- feature_flags->'ghost_a'\n/* platform_settings WHERE key='ghost_b' */ SELECT 1;`), []);
  // a string that merely contains SQL-looking text is a value, not a read
  assert.deepEqual(sqlKeys(`SELECT 'feature_flags->''ghost_c'' and platform_settings key=''ghost_d''';`), []);
  // prefix literals of concatenated keys are not keys
  assert.deepEqual(sqlKeys(`SELECT o.feature_flags->('line_'||p||'_portal') FROM platform_settings f WHERE f.key='partner_' || p_kind;`), []);
  assert.deepEqual(sqlKeys(`SELECT 1 FROM platform_settings WHERE key IN ('real_one','partner_' || p_kind);`), ["real_one"]);
  // a different alias, a sibling subquery, the next statement, parameters and JSON values
  assert.deepEqual(sqlKeys(`SELECT 1 FROM platform_settings f JOIN other_table t ON t.key='not_a_flag' WHERE f.value->'enabled'='true'::jsonb;`), []);
  assert.deepEqual(sqlKeys(`SELECT (SELECT value FROM platform_settings WHERE key='inner_flag'), (SELECT v FROM idempotency WHERE key='not_a_flag')`), ["inner_flag"]);
  assert.deepEqual(sqlKeys(`LOCK TABLE public.platform_settings IN SHARE MODE; SELECT 1 FROM idempotency WHERE key='not_a_flag';`), []);
  assert.deepEqual(sqlKeys(`SELECT 1 FROM platform_settings f WHERE f.key=k.key AND f.key=$2 AND f.value->'enabled'='true'::jsonb;`), []);
  assert.deepEqual(sqlKeys(`SELECT 1 FROM platform_settings f JOIN organizations o ON true WHERE (o.feature_flags->f.key='true'::jsonb) IS TRUE;`), []);
  assert.deepEqual(sqlKeys(`SELECT app.platform_settings.x, feature_flags FROM organizations WHERE key='not_a_flag'`), []);
});

test("self-test: TypeScript extractor decodes literals and reads only feature-flag receivers", () => {
  // r1 finding 5: escaped quotes inside an ordinary string literal
  assert.deepEqual(tsKeys(String.raw`const q = 'SELECT feature_flags->\'new_flag\' FROM organizations';`), ["new_flag"]);
  assert.deepEqual(tsKeys(String.raw`const q = "SELECT feature_flags->'unicode' FROM organizations";`), ["unicode"]);
  assert.deepEqual(tsKeys('const { rows } = await query("SELECT feature_flags -> \'brand_v2\' AS flag FROM public.organizations WHERE id = $1", [orgId]);'), ["brand_v2"]);
  assert.deepEqual(tsKeys("await client.query(`SELECT (SELECT value FROM platform_settings WHERE key='pricing_interim') AS value,\n feature_flags FROM organizations WHERE id=${id}`);\nconst other = `SELECT 1 FROM t WHERE key='not_a_flag'`;"), ["pricing_interim"]);
  assert.deepEqual(tsKeys(`const q = "SELECT value FROM platform_settings " + "WHERE key = 'joined_key'" + suffix;`), ["joined_key"]);
  // a key supplied by ${...} is dynamic, not a literal
  assert.deepEqual(tsKeys("const q = `SELECT 1 FROM platform_settings WHERE key='${k}' OR key=${p}`;"), []);
  assert.deepEqual(tsKeys("return ok && row.feature_flags?.vendor_documents === true;"), ["vendor_documents"]);
  assert.deepEqual(tsKeys('if (org.feature_flags["esign"] !== true || org.feature_flags?.[`tpl_key`] || org!.feature_flags!.custom_roles) return;'), ["custom_roles", "esign", "tpl_key"]);
  assert.deepEqual(tsKeys("return (featureFlags as Record<string, unknown>).paper_lease_versions === true && (flags as Record<string, unknown>)['import_error_details'] === true;"), ["import_error_details", "paper_lease_versions"]);
  assert.deepEqual(tsKeys("const { a_key, b_key: renamed, ...rest } = row.feature_flags; const v = (row.feature_flags as Flags).cast_key;"), ["a_key", "b_key", "cast_key"]);
  assert.deepEqual(tsKeys("const on = featureFlags.direct_key; const el = <b>{props.org.feature_flags.jsx_key ? 1 : 0}</b>;"), ["direct_key", "jsx_key"]);
});

test("self-test: TypeScript extractor ignores comments, unrelated objects and non-reads", () => {
  // r1 finding 6
  assert.deepEqual(tsKeys("const x=1;// row.feature_flags.ghost"), []);
  assert.deepEqual(tsKeys("/** feature_flags->'ghost' and platform_settings.ghost */\nexport const x = 1; /* row.feature_flags['ghost'] */"), []);
  assert.deepEqual(tsKeys("const q = `SELECT 1 -- feature_flags->'ghost'\n /* platform_settings WHERE key='ghost' */ FROM organizations`;"), []);
  assert.deepEqual(tsKeys("if (flags.loading === true) return; const y = (state as Record<string, unknown>).enabled === true;"), []);
  // a bare local named flags is ambiguous by design (documented limit): only the explicit cast counts
  assert.deepEqual(tsKeys('return flags["new_flag"] === true || f.other === true;'), []);
  // types, method calls, writes of the whole object, computed keys, ternaries
  assert.deepEqual(tsKeys("const r = await q<{ feature_flags: unknown }>(sql); row.feature_flags.toString(); const o = { feature_flags: { seeded: true } }; const v = row.feature_flags[key]; const t = row.feature_flags ? 'yes' : 'no';"), []);
  assert.deepEqual(tsKeys("const url = 'https://example.test/a'; const s = \"it's // not a comment\"; return row.feature_flags.kept;"), ["kept"]);
});

test("self-test: registry parser and the reference scan", () => {
  const reg = registryEntries(`# note\nflags:\n  alpha:\n    owner: Ron\n    org_override: "organizations.feature_flags.alpha"\n\n  BETA_ENABLED:\n    owner: Ron\n`);
  assert.deepEqual([...reg.keys()], ["alpha", "BETA_ENABLED"]);
  assert.match(reg.get("alpha") ?? "", /feature_flags\.alpha/);
  assert.throws(() => registryEntries("flags:\n  dup:\n    owner: Ron\n  dup:\n    owner: Ron\n"), /duplicate key dup/);
  const mentions = (text: string, kind: "sql" | "ts") => scanSource({ file: "f", kind, text }).mentions;
  assert.ok(mentions('enabled(client, orgId, "owner_receipt_title"); type F = "typed_key";', "ts").has("owner_receipt_title"));
  assert.ok(mentions('type F = "typed_key" | "other";', "ts").has("typed_key"));
  assert.ok(mentions("const on = process.env.ESIGN_ENABLED === 'true' || env['BRACKET_KEY'];", "ts").has("ESIGN_ENABLED"));
  assert.ok(mentions("const on = env['BRACKET_KEY'];", "ts").has("BRACKET_KEY"));
  assert.ok(mentions("const q = `SELECT app.flag_on($1,'in_sql_string')`;", "ts").has("in_sql_string"));
  assert.ok(mentions("IF NOT app.b014_flag_on(p_org,'owner_net_ledger') THEN", "sql").has("owner_net_ledger"));
  assert.ok(mentions(`INSERT INTO platform_settings(key,value) VALUES ('seeded','{"enabled":false,"allowed_org_ids":[]}') ON CONFLICT DO NOTHING;`, "sql").has("seeded"));
  assert.ok(!mentions("// owner_receipt_title is mentioned only here\nconst x = 'owner_receipt_title_v2';", "ts").has("owner_receipt_title"));
  assert.ok(!mentions("-- 'owner_net_ledger'\nSELECT 'owner_net_ledger_v2';", "sql").has("owner_net_ledger"));
});

test("self-test: drift is reported in both directions and exceptions cannot go stale", () => {
  const reg = registryEntries(`flags:\n  alpha:\n    org_override: "organizations.feature_flags.alpha"\n  BETA_ENABLED:\n    org_override: "organizations.feature_flags.beta must be true"\n  seeded_only:\n    owner: Ron\n`);
  const ex = (p: Partial<{ unregistered: [string, string][]; drift: [string, Drift][]; unreferenced: [string, string][] }> = {}): Exceptions =>
    ({ unregistered: new Map(p.unregistered), drift: new Map(p.drift), unreferenced: new Map(p.unreferenced) });
  const src = (text: string, kind: "sql" | "ts" = "ts", file = "src/x.ts"): Source => ({ file, kind, text });
  const base = [
    src("const on = row.feature_flags.alpha === true && process.env.BETA_ENABLED === 'true';"),
    src(`INSERT INTO platform_settings(key,value) VALUES ('seeded_only','{"enabled":false,"allowed_org_ids":[]}') ON CONFLICT DO NOTHING;`, "sql", "supabase/migrations/1_seed.sql"),
  ];
  assert.deepEqual(flagKeyViolations(reg, base, ex()), []);

  // read, not registered
  const v1 = flagKeyViolations(reg, [...base, src("SELECT 1 FROM organizations o WHERE o.feature_flags->'new_thing'='true'::jsonb;", "sql", "supabase/migrations/2_new.sql")], ex());
  assert.equal(v1.length, 1);
  assert.match(v1[0], /"new_thing" is read in supabase\/migrations\/2_new\.sql but is not in ops\/flags\.yaml/);
  assert.deepEqual(flagKeyViolations(reg, [...base, src("x = row.feature_flags?.new_thing === true;")], ex({ unregistered: [["new_thing", "listed for the self-test"]] })), []);

  // r1 finding 7: names inherited from Object.prototype are ordinary keys, not built-in exceptions
  for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const v = flagKeyViolations(reg, [...base, src(`SELECT 1 FROM organizations WHERE feature_flags->'${inherited}'='true'::jsonb;`, "sql", "m.sql")], ex());
    assert.equal(v.length, 1, inherited);
    assert.ok(v[0].startsWith(`flag key "${inherited}" is read in m.sql`), v[0]);
  }
  assert.match(flagKeyViolations(reg, [...base, src('const v = row.feature_flags["constructor"];')], ex())[0], /"constructor" is read/);

  // registered, referenced nowhere (a comment-only mention does not count)
  const v2 = flagKeyViolations(reg, [base[1], src("// row.feature_flags.alpha, process.env.BETA_ENABLED, 'alpha'")], ex());
  assert.deepEqual(v2.map((m) => m.match(/key "(\w+)" is not referenced/)?.[1]), ["alpha", "BETA_ENABLED"]);
  assert.deepEqual(flagKeyViolations(reg, [base[1], src("const on = process.env.BETA_ENABLED;")], ex({ unreferenced: [["alpha", "reserved for the self-test"]] })), []);

  // name drift: allowed only while the registry entry names exactly that org key
  const drifted = [...base, src("return (featureFlags as Record<string, unknown>).beta === true;")];
  assert.match(flagKeyViolations(reg, drifted, ex())[0], /"beta" is read in src\/x\.ts but is not in ops\/flags\.yaml/);
  assert.deepEqual(flagKeyViolations(reg, drifted, ex({ drift: [["beta", { registry: "BETA_ENABLED", reason: "self-test" }]] })), []);
  assert.match(flagKeyViolations(reg, drifted, ex({ drift: [["beta", { registry: "alpha", reason: "wrong pairing" }]] }))[0], /registry entry "alpha" does not name organizations\.feature_flags\.beta/);
  assert.match(flagKeyViolations(reg, drifted, ex({ drift: [["beta", { registry: "GONE", reason: "missing" }]] }))[0], /"GONE", which is not in ops\/flags\.yaml/);
  const prefix = [...base, src("return row.feature_flags.bet === true;")];
  assert.match(flagKeyViolations(reg, prefix, ex({ drift: [["bet", { registry: "BETA_ENABLED", reason: "prefix of the real key" }]] }))[0], /does not name organizations\.feature_flags\.bet$/);

  // stale exceptions
  assert.match(flagKeyViolations(reg, base, ex({ unregistered: [["alpha", "now registered"]] }))[0], /"alpha" is now in ops\/flags\.yaml — remove it from UNREGISTERED_OK/);
  assert.match(flagKeyViolations(reg, base, ex({ unregistered: [["vanished", "no reader left"]] }))[0], /"vanished" is no longer read anywhere/);
  assert.match(flagKeyViolations(reg, base, ex({ drift: [["beta", { registry: "BETA_ENABLED", reason: "no reader left" }]] }))[0], /"beta" is no longer read anywhere — remove it from NAME_DRIFT_OK/);
  assert.match(flagKeyViolations(reg, base, ex({ unreferenced: [["alpha", "is referenced"]] }))[0], /"alpha" is referenced again/);
  assert.match(flagKeyViolations(reg, base, ex({ unreferenced: [["never_there", "typo"]] }))[0], /"never_there" is not in ops\/flags\.yaml/);

  // r1 finding 8: a new unregistered key plus a matching new exception passes the drift check
  // but is stopped by the pin
  const one = ex({ unregistered: [["old_one", "known"]] });
  const sha = (e: Exceptions) => createHash("sha256").update(exceptionIds(e).join("\n")).digest("hex");
  const pin = { max: 1, count: 1, sha256: sha(one) };
  assert.deepEqual(exceptionPinProblems(one, pin), []);
  const grown = ex({ unregistered: [["old_one", "known"], ["new_thing", "sneaked in"]] });
  assert.match(exceptionPinProblems(grown, pin)[0], /adding an exception is not allowed/);
  assert.match(exceptionPinProblems(grown, { max: 1, count: 2, sha256: sha(grown) })[0], /may only shrink/);
  assert.match(exceptionPinProblems(ex({ unregistered: [["swapped", "different key"]] }), pin)[0], /never added or swapped/);
  assert.match(exceptionPinProblems(ex({ drift: [["old_one", { registry: "X", reason: "moved list" }]] }), pin)[0], /never added or swapped/);
  assert.match(exceptionPinProblems(ex(), pin)[0], /lower EXCEPTIONS_PIN\.count/);
  assert.deepEqual(exceptionPinProblems(ex(), { max: 1, count: 0, sha256: sha(ex()) }), []);
});
