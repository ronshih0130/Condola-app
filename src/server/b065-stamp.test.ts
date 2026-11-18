import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  STAMP_CONSENT_TEXT, STAMP_READINESS, STAMP_SVG_MAX_BYTES, parseConsentStampInput, parseSaveStampInput, parseStampSvg, stampSha256,
} from "./b065-stamp";

// VEN-18 (B-065 phase B slice P1): strict request parsers for the stamp gateways. The database repeats the art and
// metadata checks (b065-stamp.integration.test.ts); these keep malformed input from ever reaching it.
const svg = (inner = '<path fill="#B31B1B" d="M1 2L4 6L2 6Z"/>') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52.8 30"><rect x="0.5" y="0.5" width="51.8" height="29" fill="none" stroke="#B31B1B" stroke-width="0.6"/>${inner}</svg>`;
const requestId = "00000000-0000-4000-8000-000000000065";
const art = { svg: svg(), inputsSha256: "a".repeat(64), fontId: "lxgw-wenkai-tc-1.530-big5", generatorVersion: "d1-1", fallbackCodepoints: [0x4e00, 0x9fa5] };

test("VEN-18 constants: the approved consent sentence (rec-stamp) and the readiness reasons", () => {
  assert.equal(STAMP_CONSENT_TEXT, "我同意使用這枚印章開立收據");
  assert.deepEqual([...STAMP_READINESS], ["needs_tax_id", "needs_stamp", "stale", "needs_consent", "ready"]);
  assert.equal(STAMP_SVG_MAX_BYTES, 512 * 1024);
  const sql = readFileSync("supabase/migrations/20261118100000_b065_stamp.sql", "utf8");
  assert.equal((sql.match(/'我同意使用這枚印章開立收據'/g) ?? []).length, 2, "the CHECK and the writer use the same sentence");
  assert.match(sql, /octet_length\(p_svg\) BETWEEN 1 AND 524288/);
});

test("VEN-18 art: canonical SVG of svg/g/rect/path only; text, images, styles, scripts, references, entities, comments, extra roots and oversize refused", () => {
  assert.equal(parseStampSvg(svg()), svg());
  assert.equal(parseStampSvg(svg('<g transform="translate(1 2)"><path d="M0 0Z" fill-rule="evenodd"/></g>')), svg('<g transform="translate(1 2)"><path d="M0 0Z" fill-rule="evenodd"/></g>'));
  assert.equal(parseStampSvg(svg().replace("><rect", ">\n  <rect")), svg().replace("><rect", ">\n  <rect"), "whitespace between tags is fine");
  const bad: Array<[string, unknown]> = [
    ["not a string", 1], ["empty", ""], ["no namespace", svg().replace(' xmlns="http://www.w3.org/2000/svg"', "")],
    ["other namespace", svg().replace("2000/svg", "1999/xhtml")], ["trailing text", `${svg()} `], ["leading text", ` ${svg()}`],
    ["text element", svg("<text>安心</text>")], ["text node", svg("<g>安心</g>")], ["image", svg('<image width="1" height="1"/>')],
    ["style element", svg("<style>path{}</style>")], ["style attribute", svg('<path style="fill:red" d="M0 0Z"/>')],
    ["script", svg("<script>alert(1)</script>")], ["event handler", svg('<path onload="x" d="M0 0Z"/>')],
    ["href", svg('<path href="#a" d="M0 0Z"/>')], ["url()", svg('<path fill="url(#g)" d="M0 0Z"/>')], ["entity", svg('<path d="M0 0Z" fill="&#x23;B31B1B"/>')],
    ["comment", svg("<!-- x -->")], ["processing instruction", `<?xml version="1.0"?>${svg()}`], ["foreignObject", svg("<foreignObject/>")],
    ["use", svg('<use x="1"/>')], ["unknown attribute", svg('<path d="M0 0Z" class="x"/>')], ["duplicate attribute", svg('<path d="M0 0Z" d="M1 1Z"/>')],
    ["nested svg", svg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')], ["unbalanced", svg("<g>")], ["stray close", svg("</g>")],
    ["closing tag with attributes", svg('<g></g fill="x">')], ["two roots", `${svg()}${svg()}`], ["single quotes", svg("<path d='M0 0Z'/>")],
    ["backslash", svg('<path d="M0 0Z\\"/>')], ["oversize", svg(`<path d="${"M1 1".repeat(131072)}"/>`)],
  ];
  for (const [label, value] of bad) assert.equal(parseStampSvg(value), null, label);
});

test("VEN-18 save input: uuid request id, canonical art, inputs digest, font and generator ids, ascending distinct code points; nothing else", () => {
  assert.deepEqual(parseSaveStampInput({ requestId, ...art }), { requestId, ...art });
  assert.deepEqual(parseSaveStampInput({ requestId, ...art, fallbackCodepoints: [] }), { requestId, ...art, fallbackCodepoints: [] });
  const bad: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["missing svg", { requestId, ...art, svg: undefined }], ["extra key", { requestId, ...art, sha256: "a".repeat(64) }],
    ["consent key", { requestId, ...art, previewedSha256: "a".repeat(64) }], ["bad request id", { ...art, requestId: "x" }],
    ["bad inputs digest", { requestId, ...art, inputsSha256: "A".repeat(64) }], ["short digest", { requestId, ...art, inputsSha256: "a".repeat(63) }],
    ["bad font id", { requestId, ...art, fontId: "../font" }], ["empty generator", { requestId, ...art, generatorVersion: "" }],
    ["unsorted fallback", { requestId, ...art, fallbackCodepoints: [2, 1] }], ["duplicate fallback", { requestId, ...art, fallbackCodepoints: [1, 1] }],
    ["surrogate", { requestId, ...art, fallbackCodepoints: [0xd800] }], ["beyond Unicode", { requestId, ...art, fallbackCodepoints: [0x110000] }],
    ["negative", { requestId, ...art, fallbackCodepoints: [-1] }], ["non-integer", { requestId, ...art, fallbackCodepoints: [1.5] }],
    ["string code point", { requestId, ...art, fallbackCodepoints: ["1"] }], ["over 160", { requestId, ...art, fallbackCodepoints: Array.from({ length: 161 }, (_, i) => i + 1) }],
    ["fallback not an array", { requestId, ...art, fallbackCodepoints: null }], ["non-canonical svg", { requestId, ...art, svg: "<svg/>" }],
  ];
  for (const [label, value] of bad) assert.equal(parseSaveStampInput(value), null, label);
});

test("VEN-18-AC9 consent input: the previewed sha256 with no art, or the whole art whose recomputed sha256 is the previewed one", () => {
  const previewedSha256 = stampSha256(art.svg);
  assert.equal(previewedSha256, createHash("sha256").update(Buffer.from(art.svg, "utf8")).digest("hex"));
  assert.deepEqual(parseConsentStampInput({ requestId, previewedSha256 }), { requestId, previewedSha256, art: null });
  assert.deepEqual(parseConsentStampInput({ requestId, previewedSha256, ...art }), { requestId, previewedSha256, art });
  const bad: Array<[string, unknown]> = [
    ["no previewed sha", { requestId }], ["bad previewed sha", { requestId, previewedSha256: "x" }], ["bad request id", { requestId: "", previewedSha256 }],
    ["art that is not the previewed art", { requestId, previewedSha256, ...art, svg: svg('<path d="M9 9Z"/>') }],
    ["partial art", { requestId, previewedSha256, svg: art.svg }], ["art without metadata", { requestId, previewedSha256, svg: art.svg, inputsSha256: art.inputsSha256 }],
    ["extra key", { requestId, previewedSha256, consent: true }], ["consent text from the client", { requestId, previewedSha256, consentText: STAMP_CONSENT_TEXT }],
  ];
  for (const [label, value] of bad) assert.equal(parseConsentStampInput(value), null, label);
});
