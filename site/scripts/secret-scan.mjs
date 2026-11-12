#!/usr/bin/env node
// Pre-push / CI secret scan: .env files, token files, wrangler.toml/jsonc vars.
// Fail closed on likely live secrets. Do not print secret values.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SKIP_DIR = new Set(['.git', 'node_modules', '.wrangler', 'dist', 'dist-prod', 'deploy-dir']);

const NAME_RE = /(^|\/)\.env($|\.)|(^|\/)\.envrc$|(^|\/)wrangler\.(toml|jsonc?)$|token/i;
const ASSIGN_RE = /^\s*(?:export\s+)?([A-Z0-9_]{3,80})\s*=\s*(?:['"]?)(\S+)/;
const TOML_VAR_RE = /^\s*([A-Z0-9_]{3,80})\s*=\s*(?:['"]([^'"]+)['"]|(\S+))/;
const HIGH_RISK_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|AUTH|CREDENTIAL|CLOUDFLARE_API_TOKEN|SERVICE_ROLE)/i;
const VALUE_SHAPE = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function looksPlaceholder(v) {
  const s = v.replace(/^['"]|['"]$/g, '');
  if (!s || s === 'undefined' || s === 'null') return true;
  if (/^(\$\{?[A-Z0-9_]+\}?|<.*>|YOUR_.*|changeme|replace-me|example|todo)$/i.test(s)) return true;
  if (s.length < 8) return true;
  return false;
}

const files = walk(root);
const hits = [];

for (const file of files) {
  const rel = relative(root, file);
  const base = basename(file);
  const interesting = NAME_RE.test(rel) || NAME_RE.test(base);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  const isWrangler = /wrangler\.(toml|jsonc?)$/i.test(base);
  const isEnv = /(^|\/)\.env($|\.)|(^|\/)\.envrc$/i.test(rel);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

    let key, val;
    const m = trimmed.match(ASSIGN_RE) || (isWrangler ? trimmed.match(TOML_VAR_RE) : null);
    if (m) {
      key = m[1];
      val = (m[2] || m[3] || '').replace(/^['"]|['"]$/g, '');
    }

    const shape = VALUE_SHAPE.some((re) => re.test(line));
    const riskyKey = key && HIGH_RISK_KEY.test(key) && val && !looksPlaceholder(val);
    if (shape || (interesting && riskyKey) || (isEnv && riskyKey) || (isWrangler && riskyKey)) {
      hits.push({ file: rel, line: i + 1, reason: shape ? 'token-shape' : `assignment:${key}` });
    }
  }
}

if (hits.length) {
  console.error('secret-scan FAIL: possible secrets in:');
  for (const h of hits) console.error(`  ${h.file}:${h.line} (${h.reason})`);
  process.exit(1);
}
console.log(`secret-scan PASS (${files.length} files, .env / tokens / wrangler.toml|jsonc vars covered)`);
