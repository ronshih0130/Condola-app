import { readFile } from 'node:fs/promises';
import fg from 'fast-glob';
import { describe, expect, it, test } from 'vitest';
import { readTrialLength } from '../../../src/server/trial-length';

// Production catalog via uiCopy. Do not duplicate expected literals in the adapter.
import { uiCopy } from '../src/copy';

const WHITELIST = [
  '一起成為完美房東',
  '自動計入帳單',
  '加入帳單',
  '匯入帳戶末五碼',
  '登入帳號',
  '款項到帳',
] as const;

const BANNED = [
  '入帳', '收租', '收款', '欠租', '已收', '代收',
  '示範', '測試模式', '沙盒', '房東',
] as const;

const EXTRA = ['Condola 撥款', '平台轉付', '本公司', '含稅', '統一編號', '發票'] as const;

export function scanCopy(input: string): string[] {
  const stripped = WHITELIST.reduce(
    (text, sentence) => text.split(sentence).join(''), input,
  );
  return [...BANNED, ...EXTRA].filter(term => stripped.includes(term));
}

describe('scanner contract', () => {
  it.each([
    ['款項入帳', ['入帳']],
    ['款項到帳', []],
    ['匯入帳戶末五碼', []],
    ['一起成為完美房東', []],
    ['房東', ['房東']],
    ['一起成為完美房東 房東', ['房東']],
    ['自動計入帳單 加入帳單 登入帳號', []],
    ['Condola 撥款', ['Condola 撥款']],
    ['平台轉付', ['平台轉付']],
    ['本公司', ['本公司']],
    ['含稅', ['含稅']],
    ['統一編號', ['統一編號']],
    ['發票', ['發票']],
  ])('%s', (input, expected) => {
    expect(scanCopy(input)).toEqual(expected);
  });

  // SPEC AMBIGUITY: R23 allows 已收到 but banned list blocks 已收
  test.fails('approved 已收到 should pass once PM resolves the contradiction', () => {
    expect(scanCopy('已收到')).toEqual([]);
  });
});

describe('exact production copy', () => {
  it.each([
    ['global.disclaimer', {}, 'Condola 只提供管理軟體，不經手任何款項。'],
    ['payments.leaseRequired', {}, '請選擇租約'],
    ['payments.amountPositive', {}, '金額需大於 NT$0'],
    ['payments.futureDate', {}, '匯款日期不能晚於今天'],
    ['payments.typeRequired', {}, '請選擇款項類型'],
    ['payments.periodRequired', {}, '請選擇期別'],
    ['payments.errorSummary', {}, '有欄位需要修正，請查看標示處。'],
    ['payments.requiredSummary', {}, '還有必填欄位沒填，請檢查標示紅色的欄位'],
    ['payments.duplicate', { amount: 10000 },
      '這期租金已有一筆登記 NT$10,000。如果是分次匯款，可以繼續儲存；如果是重複登記，請取消。'],
    ['payments.reversePermission', {}, '只有管理員或會計可以撤銷登記。'],
    ['payments.reversed', {}, '已撤銷'],
    ['payments.reversalReason', { reason: '重複登記' }, '撤銷原因：重複登記'],
    ['payments.pending', {}, '待確認'],
    ['payments.confirm', {}, '確認登記'],
    ['payments.decline', {}, '不登記'],
    ['payments.readonly', {},
      '這個物件目前唯讀（超過方案戶數），仍可登記和撤銷付款，但不能編輯物件和租約。'],
    ['payments.recipient', {}, '付款對象'],
    ['payments.ownerRecipient', {}, '付給屋主'],
    ['payments.companyRecipient', {}, '付給管理公司'],
    ['payments.partial', {}, '部分付款'],
    ['payments.remaining', { amount: 8000 }, '尚未繳 NT$8,000'],
    ['payments.partialExplanation', { paid: 10000, year: 2026, month: 10 },
      '已登記 NT$10,000，先抵 2026年10月 的帳單（最舊的先抵）'],
    ['payments.overdue', { month: 10, day: 5, days: 1 }, '到期 10/05・已逾期 1 天'],
    ['tenant.total', { amount: 18000 }, '應繳合計 NT$18,000'],
    ['statement.title', { owner: 'QA屋主甲', year: 2026, month: 10 },
      'QA屋主甲・2026年10月 屋主租金結算明細'],
    ['statement.payouts', {}, '管理公司匯給屋主'],
    ['statement.opening', {}, '期初餘額'],
    ['statement.closing', {}, '期末餘額'],
    ['statement.handledRent', {}, '管理公司經手租金'],
    ['statement.negative', {}, '本期淨額為負'],
    ['statement.negativeWarning', { amount: 3300 },
      '本月費用高於已登記租金，屋主淨額為 −NT$3,300。費用怎麼處理，請和屋主確認。'],
    ['statement.changed', {}, '已變更'],
    ['statement.history', {}, '修改紀錄'],
    ['statement.regenerate', {}, '重新產生月結單'],
    ['statement.previous', {}, '修改前內容'],
    ['statement.changedNotice', {}, '這份結算表產生後有異動，請重新產生。'],
    ['statement.footer', {},
      '押金不計入淨額。此表僅供紀錄與對帳。Condola 只提供管理軟體，不經手任何款項。'],
    ['statement.formula', { opening: 5000, rent: 36000, expenses: 4200, payouts: 30000, closing: 6800 },
      '期初餘額 NT$5,000 ＋ 管理公司經手租金 NT$36,000 − 費用 NT$4,200 − 管理公司匯給屋主 NT$30,000 ＝ 期末餘額 NT$6,800'],
    ['moveout.formula', { rent: 18000, days: 12, amount: 7200 },
      'NT$18,000 ÷ 30 × 12 天 ＝ NT$7,200'],
    ['moveout.override', { actor: 'QA管理員甲', timestamp: '2026-10-12 10:00' },
      '已手動修改（QA管理員甲・2026-10-12 10:00）'],
    ['moveout.amountChange', { original: 7200, updated: 7000 },
      '原金額 NT$7,200，已改為 NT$7,000'],
    ['moveout.shortfallTitle', {}, '押金不足扣抵'],
    ['moveout.shortfall', { amount: 2500 }, '扣款超過押金，租客還需補付 NT$2,500'],
    ['period.rent', { year: 2026, month: 11 }, '2026年11月 租金'],
    ['line.previewPrivacy', {},
      'LINE 訊息只有提醒文字和連結，不會出現租客姓名、金額或地址。詳細內容要登入後才看得到。'],
    ['line.rentDue', {}, '有一筆租金快到期了，請登入查看。'],
    ['line.rentUnpaid', {}, '有一筆租金還沒登記為已繳，請登入查看。'],
    ['line.leaseExpiry', {}, '有租約快到期了，請登入安排續約或退租。'],
    ['line.repair', {}, '有修繕進度更新，請登入查看。'],
    ['line.statement', {}, '本月結算表已產生，請登入查看。'],
    ['pricing.annual', {}, '年繳・享 1 個月免費'],
    ['pricing.footer', {}, '本頁只記錄你選的方案，不會進行付款。'],
  ] as const)('%s', (key, params, expected) => {
    const actual = uiCopy(key, params);
    expect(actual).toBe(expected);
    expect(scanCopy(actual)).toEqual([]);
  });

  const trialReady = Boolean(process.env.QA_TRIAL_UNIT && process.env.QA_TRIAL_COUNT);
  it.skipIf(!trialReady)('trial copy follows QA_TRIAL_UNIT and QA_TRIAL_COUNT', () => {
    const length = readTrialLength();
    const key = length.unit === 'calendar-months' ? 'pricing.trialMonths' : 'pricing.trialDays';
    const expected = length.unit === 'calendar-months'
      ? `前 ${length.count} 個月免費`
      : `前 ${length.count} 天免費`;
    expect(uiCopy(key, { count: length.count })).toBe(expected);
    expect(scanCopy(expected)).toEqual([]);
  });
});

it('scans all selected source files after stripping whitelist sentences', async () => {
  const pattern = process.env.COPY_SCAN_GLOB ?? 'src/**/*.{ts,tsx,md}';
  const files = await fg(pattern, {
    onlyFiles: true,
    unique: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
  });
  expect(files.length, `COPY_SCAN_GLOB matched no files: ${pattern}`).toBeGreaterThan(0);
  const results = await Promise.all(files.sort().map(async file => ({
    file,
    violations: scanCopy(await readFile(file, 'utf8')),
  })));
  expect(results.filter(result => result.violations.length > 0)).toEqual([]);
});

