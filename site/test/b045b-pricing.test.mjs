import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import calc from '../assets/pricing-calc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('constants', () => {
  assert.equal(calc.FREE_UNITS, 5);
  assert.equal(calc.YEAR_MONTHS, 11);
  assert.deepEqual(calc.RATES, { std: 39, pre: 59 });
});

test('amount cases', () => {
  const cases = [
    [0, 'std', 0, 0],
    [0, 'pre', 0, 0],
    [3, 'std', 0, 0],
    [3, 'pre', 0, 0],
    [5, 'std', 0, 0],
    [5, 'pre', 0, 0],
    [6, 'std', 39, 429],
    [6, 'pre', 59, 649],
    [12, 'std', 273, 3003],
    [12, 'pre', 413, 4543],
    [200, 'std', 7605, 83655],
    [200, 'pre', 11505, 126555]
  ];
  for (const [n, plan, m, y] of cases) {
    const r = calc.amount(n, calc.RATES[plan]);
    assert.equal(r.month, m, `month n=${n} ${plan}`);
    assert.equal(r.year, y, `year n=${n} ${plan}`);
  }
});

test('parseUnits', () => {
  assert.equal(calc.parseUnits('').status, 'empty');
  assert.equal(calc.parseUnits('   ').status, 'empty');
  assert.equal(calc.parseUnits(null).status, 'empty');
  assert.equal(calc.parseUnits(undefined).status, 'empty');
  assert.equal(calc.parseUnits('-1').status, 'error');
  assert.equal(calc.parseUnits('1.5').status, 'error');
  assert.equal(calc.parseUnits('abc').status, 'error');
  assert.equal(calc.parseUnits('+1').status, 'error');
  const ok = calc.parseUnits('08');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.n, 8);
  const z = calc.parseUnits('0');
  assert.equal(z.status, 'ok');
  assert.equal(z.n, 0);
});

test('formatNT', () => {
  assert.equal(calc.formatNT(0), 'NT$0');
});

test('_redirects', () => {
  const r = read('_redirects');
  assert.ok(!r.includes('/pricing /apply'), 'must not redirect /pricing to /apply');
  assert.ok(!r.includes('/pricing.html /apply'), 'must not redirect /pricing.html to /apply');
  assert.ok(r.includes('/pricing.html /pricing 301'), 'must redirect /pricing.html to /pricing');
});

test('sitemap', () => {
  assert.ok(read('sitemap.xml').includes('https://condola.app/pricing'));
});

test('html pricing nav + footer links', () => {
  const htmlFiles = readdirSync(root).filter((f) => f.endsWith('.html'));
  assert.ok(htmlFiles.length > 0, 'expected html files in root');
  const re = /<a[^>]*href="\/pricing"[^>]*>方案價格<\/a>/;
  for (const f of htmlFiles) {
    const html = read(f);
    const fi = html.indexOf('<footer');
    assert.ok(fi > -1, `${f} has a footer`);
    const header = html.slice(0, fi);
    const footer = html.slice(fi);
    assert.ok(re.test(header), `${f} header has 方案價格 -> /pricing`);
    assert.ok(re.test(footer), `${f} footer has 方案價格 -> /pricing`);
  }
});

test('pricing.html content (gated on existence)', () => {
  if (!existsSync(join(root, 'pricing.html'))) return;
  const p = read('pricing.html');

  // three CTA hrefs
  assert.ok(p.includes('https://app.condola.app/signup'), 'signup CTA');
  assert.ok(p.includes('https://app.condola.app/signup?trial=standard'), 'standard trial CTA');
  assert.ok(p.includes('https://app.condola.app/signup?trial=premium'), 'premium trial CTA');

  // two apply hrefs
  assert.ok(p.includes('plan=std&from=site') || p.includes('plan=std&amp;from=site'), 'apply std');
  assert.ok(p.includes('plan=pre&from=site') || p.includes('plan=pre&amp;from=site'), 'apply pre');

  // no settings link
  assert.ok(!p.includes('/m/settings'), 'no /m/settings');

  // invoice sentence
  assert.ok(p.includes('目前提供收據，暫無法開立統一發票'), 'invoice sentence');

  // banned strings
  const banned = [
    '專業 Pro',
    'NT$30',
    'NT$40',
    '第 5 戶起',
    '前 4 戶免費',
    '前 3 個月免費',
    '合作期間免費',
    '含稅',
    '未稅',
    '席次',
    '送出申請後 1 個工作天內開通',
    '送出後 1 個工作天內為你開通',
    'US$',
    'USD'
  ];
  for (const b of banned) {
    assert.ok(!p.includes(b), `banned string present: ${b}`);
  }

  // FAQ order (only if all present)
  const faq = [
    '什麼算一戶？',
    '超過 5 戶怎麼計費？',
    '年繳怎麼算？',
    '怎麼開始或升級？',
    '範例公司要錢嗎？',
    '管理者人數是什麼？',
    '可以開發票嗎？',
    '標準與進階方案可以免費試用嗎？',
    '多久可以開始使用？',
    '什麼是設計夥伴？'
  ];
  if (faq.every((q) => p.includes(q))) {
    let last = -1;
    for (const q of faq) {
      const idx = p.indexOf(q);
      assert.ok(idx > last, `faq out of order: ${q}`);
      last = idx;
    }
  }
});

// Helper: return the opening tag string that carries a given id, or null.
const openTagWithId = (html, id) => {
  const m = html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`));
  return m ? m[0] : null;
};

test('PLT-38-AC1/AC3/AC4 calculator states + hidden override + form (gated on existence)', () => {
  if (!existsSync(join(root, 'pricing.html'))) return;
  const p = read('pricing.html');

  // AC1: [hidden] must beat any display rule. Allow whitespace variation and an optional ;
  assert.match(
    p,
    /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/i,
    '[hidden]{display:none!important} rule required in <style>'
  );

  // AC3: all five calculator state nodes exist
  const allIds = ['calc-empty', 'calc-res', 'calc-free', 'calc-err', 'calc-trial'];
  for (const id of allIds) {
    assert.ok(openTagWithId(p, id), `#${id} exists`);
  }

  // AC3: these four states are hidden in the initial HTML
  for (const id of ['calc-res', 'calc-free', 'calc-err', 'calc-trial']) {
    const tag = openTagWithId(p, id);
    assert.ok(/\bhidden\b/.test(tag), `#${id} is marked hidden in initial HTML`);
  }

  // AC4: calculator lives inside a <form> (or there is a submit handler) so a blank
  // submit can surface the error sentence.
  const hasForm = /<form[\s>]/i.test(p);
  const calcJsPath = join(root, 'assets', 'pricing-calc.js');
  const calcJs = existsSync(calcJsPath) ? readFileSync(calcJsPath, 'utf8') : '';
  const submitRe = /on\s*submit|addEventListener\(\s*['"]submit['"]/i;
  const hasSubmit = submitRe.test(p) || submitRe.test(calcJs);
  assert.ok(hasForm || hasSubmit, 'calculator is inside a <form> or wires a submit handler');

  // the error sentence must be available to show
  const sentence = '請填 0 或以上的整數戶數。';
  assert.ok(
    p.includes(sentence) || calcJs.includes(sentence),
    'blank-submit error sentence present'
  );
});

test('PLT-37-AC8 免費開始 link has 44px tap target (gated on existence)', () => {
  if (!existsSync(join(root, 'pricing.html'))) return;
  const p = read('pricing.html');

  const tag = openTagWithId(p, 'calc-free');
  assert.ok(tag, '#calc-free exists');

  // Collect the anchor's own classes + inline style, and every <style> block.
  const classAttr = (tag.match(/class="([^"]*)"/) || [, ''])[1];
  const classes = classAttr.split(/\s+/).filter(Boolean);
  const inlineStyle = (tag.match(/style="([^"]*)"/) || [, ''])[1];

  // Selectors that target this anchor: its id plus each of its classes.
  const selectors = ['#calc-free', ...classes.map((c) => '.' + c)];

  const styleBlocks = [...p.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((x) => x[1])
    .join('\n');

  // Accumulate CSS declarations that apply to the anchor (inline + matching rules).
  let css = inlineStyle;
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let rm;
  while ((rm = ruleRe.exec(styleBlocks))) {
    const sel = rm[1];
    if (selectors.some((s) => sel.includes(s))) css += '\n' + rm[2];
  }

  const has44H = /min-(?:height|block-size)\s*:\s*44px/i.test(css);
  const has44W = /min-(?:width|inline-size)\s*:\s*44px/i.test(css);

  assert.ok(has44H, '#calc-free must set min-height/min-block-size: 44px');
  assert.ok(has44W, '#calc-free must set min-width/min-inline-size: 44px');
});

// ---------------------------------------------------------------------------
// B-045b (S1): secret-scan must detect Wrangler JSON/JSONC "KEY": "value"
// assignments the same way it detects TOML KEY = value. Previously a high-risk
// JSONC vars assignment with no token-shaped value PASSed (false negative).
// These tests scan an isolated temp tree (argv root) so they never touch site/.
// ---------------------------------------------------------------------------

const SCANNER = join(root, 'scripts', 'secret-scan.mjs');
const SYNTHETIC = 'synthetic_jsonc_fixture_token_not_real_0001'; // clearly fake, not VALUE_SHAPE
const runScan = (dir) => {
  const r = spawnSync(process.execPath, [SCANNER, dir], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

test('B-045b secret-scan FAILs on JSONC wrangler high-risk var (regression)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'b045b-jsonc-'));
  try {
    const jsonc = [
      '// wrangler config (test fixture)',
      '{',
      '  "name": "b045b-fixture",',
      '  /* vars block below, with a comment between keys */',
      '  "vars": {',
      '    // high-risk assignment, must be detected',
      `    "CLOUDFLARE_API_TOKEN": "${SYNTHETIC}",`,
      '    // this placeholder must NOT be the reason for failure',
      '    "OTHER_TOKEN": "YOUR_TOKEN",',
      '  },',
      '}',
      ''
    ].join('\n');
    writeFileSync(join(tmp, 'wrangler.jsonc'), jsonc);

    const { status, out } = runScan(tmp);

    assert.notEqual(status, 0, 'scanner must FAIL (non-zero) on JSONC high-risk var');
    assert.ok(out.includes('wrangler.jsonc'), 'output names the file');
    assert.match(out, /wrangler\.jsonc:\d+/, 'output includes a line number');
    assert.ok(out.includes('CLOUDFLARE_API_TOKEN'), 'output names the key');
    // Never leak the secret value, and the placeholder must not drive the failure.
    assert.ok(!out.includes(SYNTHETIC), 'output must NOT contain the synthetic value');
    assert.ok(!out.includes('YOUR_TOKEN'), 'placeholder must not be the reason');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('B-045b equivalent TOML wrangler high-risk var still FAILs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'b045b-toml-'));
  try {
    const toml = [
      '# wrangler config (test fixture)',
      'name = "b045b-fixture"',
      '[vars]',
      `CLOUDFLARE_API_TOKEN = "${SYNTHETIC}"`,
      'OTHER_TOKEN = "YOUR_TOKEN"',
      ''
    ].join('\n');
    writeFileSync(join(tmp, 'wrangler.toml'), toml);

    const { status, out } = runScan(tmp);

    assert.notEqual(status, 0, 'TOML high-risk var must FAIL');
    assert.ok(out.includes('CLOUDFLARE_API_TOKEN'), 'output names the key');
    assert.ok(!out.includes(SYNTHETIC), 'output must NOT contain the synthetic value');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('B-045b placeholder-only JSONC wrangler PASSes', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'b045b-pass-'));
  try {
    const jsonc = [
      '{',
      '  // only placeholders / env refs here',
      '  "vars": {',
      '    "CLOUDFLARE_API_TOKEN": "YOUR_TOKEN",',
      '    "SERVICE_ROLE_SECRET": "${SERVICE_ROLE_SECRET}",',
      '  },',
      '}',
      ''
    ].join('\n');
    writeFileSync(join(tmp, 'wrangler.jsonc'), jsonc);

    const { status } = runScan(tmp);
    assert.equal(status, 0, 'placeholder-only JSONC must PASS');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
