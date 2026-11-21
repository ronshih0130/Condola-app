#!/usr/bin/env node
// Production artifact: /pricing and /apply are omitted (HTTP 404 via 404.html)
// and those paths get X-Robots-Tag: noindex, nofollow. Do not use this
// artifact for staging (staging serves the source pages with a noindex overlay).
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dest = join(root, 'dist-prod');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const skip = new Set([
  'dist-prod',
  'node_modules',
  'test',
  'scripts',
  'package.json',
  '.gitignore',
  'SITE-SOURCE.md',
  'B-045b.md',
  'pricing-copy.zh-TW.json',
]);

import { readdirSync, statSync } from 'node:fs';
for (const name of readdirSync(root)) {
  if (skip.has(name) || name.startsWith('.git')) continue;
  cpSync(join(root, name), join(dest, name), { recursive: true });
}

for (const gone of ['pricing.html', 'apply.html']) {
  const p = join(dest, gone);
  if (existsSync(p)) rmSync(p);
}

// Prod redirects: do not 301 /pricing.html to a now-missing /pricing.
const redirPath = join(dest, '_redirects');
let redirects = existsSync(redirPath) ? readFileSync(redirPath, 'utf8') : '';
redirects = redirects
  .split(/\r?\n/)
  .filter((line) => !/^\/pricing(?:\.html)?\s+/.test(line) && !/^\/apply(?:\.html)?\s+\//.test(line))
  .join('\n');
if (!redirects.endsWith('\n')) redirects += '\n';
writeFileSync(redirPath, redirects);

const hdrPath = join(dest, '_headers');
let headers = existsSync(hdrPath) ? readFileSync(hdrPath, 'utf8') : '';
if (!headers.endsWith('\n')) headers += '\n';
const robotsBlock = `
/pricing
  X-Robots-Tag: noindex, nofollow
/pricing.html
  X-Robots-Tag: noindex, nofollow
/apply
  X-Robots-Tag: noindex, nofollow
/apply.html
  X-Robots-Tag: noindex, nofollow
`;
if (!headers.includes('/pricing\n  X-Robots-Tag')) headers += robotsBlock;
writeFileSync(hdrPath, headers);

// Prod sitemap must not advertise non-public /pricing or /apply.
const sitemapPath = join(dest, 'sitemap.xml');
if (existsSync(sitemapPath)) {
  let sm = readFileSync(sitemapPath, 'utf8');
  sm = sm.replace(/\s*<url>\s*<loc>https:\/\/condola\.app\/(?:pricing|apply)<\/loc>\s*<\/url>/g, '');
  writeFileSync(sitemapPath, sm);
}

// Verify prod artifact
const mustMissing = ['pricing.html', 'apply.html'];
for (const f of mustMissing) {
  if (existsSync(join(dest, f))) {
    console.error('build-prod FAIL: prod artifact still contains', f);
    process.exit(1);
  }
}
const prodHdr = readFileSync(hdrPath, 'utf8');
for (const path of ['/pricing', '/pricing.html', '/apply', '/apply.html']) {
  const re = new RegExp(path.replace('.', '\\.') + '\\n\\s+X-Robots-Tag:\\s*noindex, nofollow');
  if (!re.test(prodHdr)) {
    console.error('build-prod FAIL: missing noindex header for', path);
    process.exit(1);
  }
}
const prodRedir = readFileSync(redirPath, 'utf8');
if (/^\/pricing(?:\.html)?\s+/m.test(prodRedir) || /^\/apply(?:\.html)?\s+\//m.test(prodRedir)) {
  console.error('build-prod FAIL: prod _redirects still routes /pricing or /apply');
  process.exit(1);
}
if (existsSync(sitemapPath)) {
  const sm = readFileSync(sitemapPath, 'utf8');
  if (/condola\.app\/pricing/.test(sm) || /condola\.app\/apply/.test(sm)) {
    console.error('build-prod FAIL: dist-prod sitemap still lists /pricing or /apply');
    process.exit(1);
  }
}
if (!existsSync(join(dest, '404.html')) || !existsSync(join(dest, 'index.html'))) {
  console.error('build-prod FAIL: missing 404.html or index.html');
  process.exit(1);
}
const four = readFileSync(join(dest, '404.html'), 'utf8');
if (!/noindex/i.test(four)) {
  console.error('build-prod FAIL: 404.html must keep noindex');
  process.exit(1);
}
// Source page still has trial buttons and must not bake global noindex
const src = readFileSync(join(root, 'pricing.html'), 'utf8');
if (!src.includes('signup?trial=standard') || !src.includes('signup?trial=premium')) {
  console.error('build-prod FAIL: source pricing.html lost trial CTAs');
  process.exit(1);
}
if (/name=["']robots["'][^>]*noindex/i.test(src) || /X-Robots-Tag/i.test(src)) {
  console.error('build-prod FAIL: noindex must not be baked into source pricing.html');
  process.exit(1);
}
console.log('build-prod PASS → dist-prod/ (/pricing and /apply omitted, 404 + noindex, sitemap stripped)');
