/* Condola pricing calculator — works in Node (CommonJS) and browser (global). */
(function (global) {
  'use strict';

  var FREE_UNITS = 5;
  var RATES = { std: 39, pre: 59 };
  var YEAR_MONTHS = 11;

  // parseUnits(raw):
  //   null/undefined or trimmed '' -> {status:'empty'}
  //   not a non-negative integer    -> {status:'error'}  ('-1','1.5','abc','+1')
  //   non-negative integer          -> {status:'ok', n}  ('08' -> 8)
  function parseUnits(raw) {
    if (raw === null || raw === undefined) return { status: 'empty' };
    var s = String(raw).trim();
    if (s === '') return { status: 'empty' };
    if (!/^\d+$/.test(s)) return { status: 'error' };
    return { status: 'ok', n: parseInt(s, 10) };
  }

  // amount(n, rate) -> {month, year}
  function amount(n, rate) {
    var billable = Math.max(0, n - FREE_UNITS);
    var month = billable * rate;
    return { month: month, year: month * YEAR_MONTHS };
  }

  function formatNT(n) {
    return 'NT$' + Number(n).toLocaleString('zh-TW');
  }

  var api = {
    FREE_UNITS: FREE_UNITS,
    RATES: RATES,
    YEAR_MONTHS: YEAR_MONTHS,
    parseUnits: parseUnits,
    amount: amount,
    formatNT: formatNT
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.PricingCalc = api;
  }
})(typeof window !== 'undefined' ? window : this);
