#!/usr/bin/env node
/**
 * New functions in the diff must REVOKE EXECUTE from PUBLIC, anon, and authenticated
 * unless the signature is listed in supabase/rpc-allowlist.txt.
 *
 * REVOKE ALL counts as REVOKE EXECUTE. Hits print as file:line: signature.
 * The same run prints a markdown permissions table (and writes it with --table).
 * Exit 0 when clean, 1 on a missing revoke, 2 on bad usage.
 *
 *   node scripts/ci/function-revokes.mjs
 *   node scripts/ci/function-revokes.mjs --diff change.diff --allowlist supabase/rpc-allowlist.txt --table permissions-table.md
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiff } from "./parse-diff.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ALLOWLIST_PATH = join(repoRoot, "supabase", "rpc-allowlist.txt");
const REQUIRED_ROLES = ["public", "anon", "authenticated"];
const TYPE_WORDS = new Set(
  "integer int int2 int4 int8 bigint smallint text uuid boolean bool jsonb json bytea date numeric decimal float double real varchar character char timestamp timestamptz time void citext serial bigserial name".split(
    " ",
  ),
);

function blankSql(text) {
  const comments = text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, (match) => " ".repeat(match.length));
  return comments.replace(/'(?:[^']|'')*'/g, (match) => `'${" ".repeat(Math.max(0, match.length - 2))}'`);
}

function addedDocument(file) {
  let text = "";
  const lines = [];
  for (const row of file.added) {
    const start = text.length;
    text += `${row.text}\n`;
    for (let index = start; index < text.length; index += 1) lines.push(row.line);
  }
  return {
    text,
    lineOf(index) {
      return lines[index] || file.added[0]?.line || 1;
    },
  };
}

function collapseType(value) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/\s*,\s*/g, ",")
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")");
}

function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of args) {
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function argType(raw) {
  let value = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  value = value.replace(/^(INOUT|IN|OUT|VARIADIC)\s+/i, "");
  value = value.replace(/\s+DEFAULT\b[\s\S]*$/i, "");
  value = value.replace(/\s*=[\s\S]*$/, "").trim();
  if (!value) return "";
  const named = /^([a-zA-Z_][\w$]*)\s+(.+)$/.exec(value);
  if (named && !TYPE_WORDS.has(named[1].toLowerCase())) return collapseType(named[2]);
  return collapseType(value);
}

export function normalizeName(name) {
  return name
    .replace(/\s+/g, "")
    .split(".")
    .map((part) => part.replace(/^"|"$/g, "").toLowerCase())
    .join(".");
}

export function signatureOf(name, argsRaw) {
  const types = splitArgs(argsRaw).map(argType).filter((type) => type !== "");
  return `${normalizeName(name)}(${types.join(", ")})`;
}

export function normalizeSignature(raw) {
  const match = /^(.+?)\((.*)\)\s*$/.exec(raw.trim());
  if (!match) return "";
  return signatureOf(match[1], match[2]);
}

export function parseAllowlist(text) {
  const signatures = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const signature = normalizeSignature(line);
    if (signature) signatures.push(signature);
  }
  return signatures;
}

function readName(text, index) {
  const match = /^((?:"[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$]*))?)/.exec(text.slice(index));
  if (!match) return null;
  return { name: match[1], next: index + match[0].length };
}

function readArgs(text, index) {
  while (text[index] === " " || text[index] === "\n" || text[index] === "\t") index += 1;
  if (text[index] !== "(") return null;
  index += 1;
  const start = index;
  let depth = 1;
  while (index < text.length && depth > 0) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") depth -= 1;
    if (depth > 0) index += 1;
  }
  return { args: text.slice(start, index), next: index + 1 };
}

function findFunctions(document) {
  const source = blankSql(document.text);
  const found = [];
  const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+/gi;
  let match = pattern.exec(source);
  while (match) {
    const name = readName(source, match.index + match[0].length);
    const args = name ? readArgs(source, name.next) : null;
    if (name && args) {
      found.push({
        name: normalizeName(name.name),
        signature: signatureOf(name.name, args.args),
        line: document.lineOf(match.index),
      });
      pattern.lastIndex = args.next;
    }
    match = pattern.exec(source);
  }
  return found;
}

function findRevokes(document) {
  const source = blankSql(document.text);
  const found = [];
  const pattern = /REVOKE\s+(ALL|EXECUTE)\s+ON\s+FUNCTION\s+/gi;
  let match = pattern.exec(source);
  while (match) {
    const start = match.index + match[0].length;
    const name = readName(source, start);
    if (!name) {
      match = pattern.exec(source);
      continue;
    }
    let next = name.next;
    let args = null;
    while (source[next] === " " || source[next] === "\n" || source[next] === "\t") next += 1;
    if (source[next] === "(") {
      args = readArgs(source, next);
      if (args) next = args.next;
    }
    const from = /^\s*FROM\s+([^;]+)/i.exec(source.slice(next));
    if (from) {
      const roles = from[1]
        .split(",")
        .map((role) => role.trim().replace(/"/g, "").toLowerCase())
        .filter((role) => REQUIRED_ROLES.includes(role));
      found.push({
        privilege: match[1].toLowerCase(),
        name: normalizeName(name.name),
        signature: args ? signatureOf(name.name, args.args) : "",
        roles,
      });
      pattern.lastIndex = next + from[0].length;
    }
    match = pattern.exec(source);
  }
  return found;
}

function covers(revoke, fn, role) {
  if (revoke.name !== fn.name) return false;
  if (revoke.signature && revoke.signature !== fn.signature) return false;
  if (revoke.privilege !== "all" && revoke.privilege !== "execute") return false;
  return revoke.roles.includes(role);
}

function roleLabel(role) {
  return role === "public" ? "PUBLIC" : role;
}

export function permissionRows(diffText, allowlistText) {
  const allowed = new Set(parseAllowlist(allowlistText || ""));
  const rows = [];
  for (const file of parseDiff(diffText)) {
    const paths = [file.path, file.oldPath].filter(Boolean);
    if (!paths.some((path) => path.endsWith(".sql"))) continue;
    const document = addedDocument(file);
    const revokes = findRevokes(document);
    for (const fn of findFunctions(document)) {
      const roles = {};
      for (const role of REQUIRED_ROLES) {
        roles[roleLabel(role)] = revokes.some((revoke) => covers(revoke, fn, role)) ? "revoked" : "missing";
      }
      const missing = REQUIRED_ROLES.filter((role) => roles[roleLabel(role)] === "missing").map(roleLabel);
      const allowlisted = allowed.has(fn.signature);
      rows.push({
        path: file.path,
        line: fn.line,
        signature: fn.signature,
        allowlisted,
        roles,
        missing,
        ok: allowlisted || missing.length === 0,
      });
    }
  }
  return rows;
}

export function checkAddedFunctions(diffText, allowlistText) {
  return permissionRows(diffText, allowlistText)
    .filter((row) => !row.ok)
    .map((row) => ({
      path: row.path,
      line: row.line,
      signature: row.signature,
      missing: row.missing,
      message: `${row.path}:${row.line}: ${row.signature} missing REVOKE EXECUTE FROM ${row.missing.join(", ")}`,
    }));
}

export function renderPermissionsTable(rows) {
  const intro =
    rows.length === 0
      ? "No new SQL functions in this diff."
      : "New SQL functions in this diff. A signature in supabase/rpc-allowlist.txt may omit REVOKE EXECUTE. Every other new function must revoke EXECUTE from PUBLIC, anon, and authenticated.";
  const lines = [
    "# Function EXECUTE permissions",
    "",
    intro,
    "",
    "| file | line | signature | allowlisted | PUBLIC | anon | authenticated | result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.path} | ${row.line} | \`${row.signature}\` | ${row.allowlisted ? "yes" : "no"} | ${row.roles.PUBLIC} | ${row.roles.anon} | ${row.roles.authenticated} | ${row.ok ? "pass" : "fail"} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function gitDiff() {
  return execFileSync("git", ["-C", repoRoot, "diff", "--unified", "--find-renames", "origin/main...HEAD"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function main() {
  const args = process.argv.slice(2);
  let diffPath = "";
  let allowPath = ALLOWLIST_PATH;
  let tablePath = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--diff") {
      diffPath = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--allowlist") {
      allowPath = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--table") {
      tablePath = args[index + 1] || "";
      index += 1;
      continue;
    }
    console.error("Usage: node scripts/ci/function-revokes.mjs [--diff file] [--allowlist file] [--table file]");
    process.exit(2);
  }
  const diffText = diffPath ? readFileSync(diffPath, "utf8") : gitDiff();
  const allowText = allowPath && existsSync(allowPath) ? readFileSync(allowPath, "utf8") : "";
  const rows = permissionRows(diffText, allowText);
  const table = renderPermissionsTable(rows);
  console.log(table);
  if (tablePath) writeFileSync(tablePath, table);
  const problems = rows.filter((row) => !row.ok);
  if (problems.length === 0) {
    console.log("function revokes: clean");
    return 0;
  }
  for (const row of problems) {
    console.error(`${row.path}:${row.line}: ${row.signature} missing REVOKE EXECUTE FROM ${row.missing.join(", ")}`);
  }
  return 1;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main());
