#!/usr/bin/env node
// Static-site "build": required files exist and /pricing is not redirected to /apply.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const need = [
  'pricing.html',
  'index.html',
  '_redirects',
  '_headers',
  'sitemap.xml',
  'robots.txt',
  'assets/pricing-calc.js',
  'assets/mock-tokens.css',
];
const missing = need.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error('build-check FAIL missing:', missing.join(', '));
  process.exit(1);
}
const redirects = readFileSync(join(root, '_redirects'), 'utf8');
if (/^\/pricing(?:\.html)?\s+\/apply\b/m.test(redirects)) {
  console.error('build-check FAIL: /pricing still redirects to /apply');
  process.exit(1);
}
if (!/^\/pricing\.html\s+\/pricing\s+301\b/m.test(redirects)) {
  console.error('build-check FAIL: /pricing.html must 301 to /pricing');
  process.exit(1);
}
const sitemap = readFileSync(join(root, 'sitemap.xml'), 'utf8');
if (!sitemap.includes('https://condola.app/pricing')) {
  console.error('build-check FAIL: sitemap missing /pricing');
  process.exit(1);
}
const pricing = readFileSync(join(root, 'pricing.html'), 'utf8');
if (/name=["']robots["'][^>]*noindex/i.test(pricing) || /X-Robots-Tag/i.test(pricing)) {
  console.error('build-check FAIL: noindex must not be baked into prod pricing.html');
  process.exit(1);
}
console.log('build-check PASS');
