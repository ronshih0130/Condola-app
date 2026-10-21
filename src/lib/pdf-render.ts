import * as fontkitModule from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PdfDocument } from "@/lib/pdf-document";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const LEFT = 48;
const RIGHT = 547.28;
const TOP = 58;
const BOTTOM = 52;
const INK = rgb(46 / 255, 38 / 255, 34 / 255);
const MUTED = rgb(122 / 255, 107 / 255, 97 / 255);
const PRIMARY = rgb(180 / 255, 83 / 255, 42 / 255);

type FontkitLike = Parameters<PDFDocument["registerFontkit"]>[0];
type GlyphFont = { glyphForCodePoint(code: number): { id: number } };
type FontkitApi = FontkitLike & {
  create(buffer: Uint8Array, postscriptName?: string): GlyphFont;
};

/**
 * The published ESM build is `export default fontkit`. Webpack's namespace import
 * only exposes that default; Node's loader also surfaces `create` as a named export.
 */
function loadFontkit(): FontkitApi {
  const mod = fontkitModule as unknown as FontkitApi & { default?: FontkitApi };
  if (typeof mod.default?.create === "function") return mod.default;
  return mod;
}

/**
 * Build a PDF in the caller's process. Pass the lazily loaded Traditional Chinese
 * subset; Latin digits and the document hash are drawn with Helvetica.
 */
export async function renderPdf(doc: PdfDocument, fontBytes: Uint8Array): Promise<Uint8Array> {
  const fontkit = loadFontkit();
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const source = fontkit.create(fontBytes);
  const cjk = await pdf.embedFont(fontBytes, { subset: true });
  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  const latinOk = new Map<string, boolean>();

  function canLatin(ch: string) {
    const cached = latinOk.get(ch);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      latin.widthOfTextAtSize(ch, 10);
      ok = true;
    } catch {
      ok = false;
    }
    latinOk.set(ch, ok);
    return ok;
  }

  function hasCjk(ch: string) {
    const code = ch.codePointAt(0) ?? 0;
    return source.glyphForCodePoint(code).id !== 0;
  }

  function normalize(text: string) {
    let out = "";
    for (const ch of text.replaceAll("\r", "")) {
      if (ch === "\n" || ch === "□" || ch === "■") {
        out += ch;
        continue;
      }
      out += hasCjk(ch) || canLatin(ch) ? ch : "?";
    }
    return out;
  }

  /** The embedded face has no ballot box. □ and ■ are drawn, not substituted. */
  type Piece = { text: string; font: PDFFont | null; box: "empty" | "checked" | null };

  function pieces(text: string): Piece[] {
    const out: Piece[] = [];
    for (const ch of normalize(text).replaceAll("\n", "")) {
      if (ch === "□" || ch === "■") {
        out.push({ text: ch, font: null, box: ch === "■" ? "checked" : "empty" });
        continue;
      }
      const font = hasCjk(ch) ? cjk : latin;
      const last = out[out.length - 1];
      if (last && last.font === font && !last.box) last.text += ch;
      else out.push({ text: ch, font, box: null });
    }
    return out;
  }

  function pieceWidth(piece: Piece, size: number) {
    if (piece.box) return size * 0.95;
    return piece.font!.widthOfTextAtSize(piece.text, size);
  }

  function measure(text: string, size: number) {
    return pieces(text).reduce((sum, piece) => sum + pieceWidth(piece, size), 0);
  }

  function drawAt(target: PDFPage, text: string, x: number, y: number, size: number, color: ReturnType<typeof rgb>) {
    let cursor = x;
    for (const piece of pieces(text)) {
      if (piece.box) {
        const side = size * 0.72;
        const bottom = y + size * 0.06;
        target.drawRectangle({
          x: cursor,
          y: bottom,
          width: side,
          height: side,
          borderColor: color,
          borderWidth: 0.7,
        });
        if (piece.box === "checked") {
          const inset = side * 0.22;
          target.drawRectangle({
            x: cursor + inset,
            y: bottom + inset,
            width: side - inset * 2,
            height: side - inset * 2,
            color,
          });
        }
        cursor += pieceWidth(piece, size);
        continue;
      }
      if (!piece.text || !piece.font) continue;
      target.drawText(piece.text, { font: piece.font, size, x: cursor, y, color });
      cursor += piece.font.widthOfTextAtSize(piece.text, size);
    }
  }

  function wrap(text: string, size: number, maxWidth: number) {
    const lines: string[] = [];
    for (const paragraph of normalize(text).split("\n")) {
      if (!paragraph) {
        lines.push("");
        continue;
      }
      let line = "";
      for (const ch of paragraph) {
        const next = line + ch;
        if (line && measure(next, size) > maxWidth) {
          lines.push(line);
          line = ch === " " ? "" : ch;
        } else {
          line = next;
        }
      }
      if (line) lines.push(line);
    }
    return lines.length ? lines : [""];
  }

  function drawFooter(target: PDFPage) {
    const label = doc.footerLabel.trim();
    const hash = doc.footerHash.trim();
    if (!label && !hash) return;
    let x = LEFT;
    if (label) {
      drawAt(target, label, x, 28, 9, MUTED);
      x += measure(label, 9) + (hash ? 8 : 0);
    }
    if (hash && /^[\x20-\x7e]+$/.test(hash)) {
      target.drawText(hash, { font: latin, size: 9, x, y: 28, color: MUTED });
    }
  }

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - TOP;
  const openPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: PRIMARY });
    drawFooter(page);
    y = PAGE_H - TOP;
  };
  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: PRIMARY });
  drawFooter(page);

  function need(height: number) {
    if (y - height < BOTTOM) openPage();
  }

  for (const line of wrap(doc.title, 18, RIGHT - LEFT)) {
    need(24);
    drawAt(page, line, LEFT, y, 18, INK);
    y -= 24;
  }
  if (doc.subtitle.trim()) {
    for (const line of wrap(doc.subtitle, 11, RIGHT - LEFT)) {
      need(16);
      drawAt(page, line, LEFT, y, 11, MUTED);
      y -= 16;
    }
  }
  y -= 6;

  for (const block of doc.blocks) {
    if (block.heading.trim()) {
      need(28);
      y -= 8;
      drawAt(page, block.heading, LEFT, y, 12, PRIMARY);
      y -= 18;
    }
    if (block.kind === "rows") {
      for (const row of block.rows) {
        const wide = measure(row.label, 10) > 148;
        if (wide) {
          for (const line of wrap(row.label, 10, RIGHT - LEFT)) {
            need(14);
            drawAt(page, line, LEFT, y, 10, MUTED);
            y -= 14;
          }
        }
        const valueWidth = wide ? RIGHT - LEFT : RIGHT - (LEFT + 156);
        const valueLines = wrap(row.value, 11, valueWidth);
        valueLines.forEach((line, index) => {
          need(16);
          if (!wide && index === 0) drawAt(page, row.label, LEFT, y, 10, MUTED);
          drawAt(page, line, wide ? LEFT : LEFT + 156, y, 11, INK);
          y -= 16;
        });
      }
    } else {
      for (const line of block.lines) {
        for (const part of wrap(line, 11, RIGHT - LEFT)) {
          need(16);
          drawAt(page, part, LEFT, y, 11, INK);
          y -= 16;
        }
      }
    }
  }

  try {
    pdf.setTitle(doc.title);
  } catch {
    // The visible title is already drawn with the embedded font.
  }
  return pdf.save();
}
