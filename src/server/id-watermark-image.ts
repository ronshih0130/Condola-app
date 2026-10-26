import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as fontkitModule from "@pdf-lib/fontkit";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { idFixedWatermark } from "@/lib/id-watermark";
import { MAX_PHOTO_BYTES, sniffIdImage } from "@/lib/jpeg-size";

type FontkitApi = {
  create(buffer: Uint8Array): GlyphFont;
};
type GlyphFont = {
  unitsPerEm: number;
  glyphForCodePoint(code: number): { id: number; advanceWidth: number; path: GlyphPath };
};
type GlyphPath = { commands: { command: string; args: number[] }[] };
type Mask = { width: number; height: number; ox: number; oy: number; advance: number; alpha: Uint8Array };

const masks = new Map<string, Mask>();
const fontBin = new Map<"cjk" | "latin", Uint8Array>();
let cjkFont: GlyphFont | null = null;
let latinFont: GlyphFont | null = null;

export class IdWatermarkError extends Error {
  constructor(message = "id watermark") {
    super(message);
    this.name = "IdWatermarkError";
  }
}

function loadFontkit(): FontkitApi {
  const mod = fontkitModule as unknown as FontkitApi & { default?: FontkitApi };
  if (typeof mod.default?.create === "function") return mod.default;
  return mod;
}

type BundledFonts = { cjk?: ArrayBuffer; latin?: ArrayBuffer };

const FONT_FILES = {
  cjk: "public/fonts/DroidSansFallback-subset.ttf",
  latin: "src/server/fonts/DejaVuSans.ttf",
} as const;

/** Worker entry sets this from Wrangler Data modules. Node tests read the files. */
function bundledFont(which: "cjk" | "latin") {
  const fonts = (globalThis as { __CONDOLA_FONTS?: BundledFonts }).__CONDOLA_FONTS;
  const bin = fonts?.[which];
  if (!bin || bin.byteLength < 1024) return null;
  return bin instanceof Uint8Array ? bin : new Uint8Array(bin);
}

function fontBytesFromDisk(relative: string) {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return new Uint8Array(readFileSync(candidate));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new IdWatermarkError("font");
}

/** Parsed faces and glyph masks stay on the module so the next photo skips fontkit. */
function fontBytes(which: "cjk" | "latin") {
  const cached = fontBin.get(which);
  if (cached) return cached;
  const bytes = bundledFont(which) ?? fontBytesFromDisk(FONT_FILES[which]);
  if (bytes.length < 1024 || bytes[0] !== 0 || bytes[1] !== 1 || bytes[2] !== 0 || bytes[3] !== 0) {
    throw new IdWatermarkError("font");
  }
  fontBin.set(which, bytes);
  return bytes;
}

function fonts() {
  if (!cjkFont || !latinFont) {
    const fontkit = loadFontkit();
    cjkFont = fontkit.create(fontBytes("cjk"));
    latinFont = fontkit.create(fontBytes("latin"));
  }
  return { cjk: cjkFont, latin: latinFont };
}

function contours(path: GlyphPath) {
  const subs: [number, number][][] = [];
  let cur: [number, number][] = [];
  let sx = 0;
  let sy = 0;
  let x = 0;
  let y = 0;
  const push = (nx: number, ny: number) => {
    cur.push([nx, ny]);
    x = nx;
    y = ny;
  };
  for (const cmd of path.commands) {
    const a = cmd.args;
    if (cmd.command === "moveTo") {
      if (cur.length) subs.push(cur);
      cur = [];
      sx = a[0] ?? 0;
      sy = a[1] ?? 0;
      x = sx;
      y = sy;
      cur.push([x, y]);
    } else if (cmd.command === "lineTo") {
      push(a[0] ?? x, a[1] ?? y);
    } else if (cmd.command === "quadraticCurveTo") {
      const cx = a[0] ?? x;
      const cy = a[1] ?? y;
      const ex = a[2] ?? x;
      const ey = a[3] ?? y;
      const x0 = x;
      const y0 = y;
      for (let step = 1; step <= 8; step += 1) {
        const t = step / 8;
        const u = 1 - t;
        push(u * u * x0 + 2 * u * t * cx + t * t * ex, u * u * y0 + 2 * u * t * cy + t * t * ey);
      }
    } else if (cmd.command === "bezierCurveTo") {
      const c1x = a[0] ?? x;
      const c1y = a[1] ?? y;
      const c2x = a[2] ?? x;
      const c2y = a[3] ?? y;
      const ex = a[4] ?? x;
      const ey = a[5] ?? y;
      const x0 = x;
      const y0 = y;
      for (let step = 1; step <= 8; step += 1) {
        const t = step / 8;
        const u = 1 - t;
        push(
          u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex,
          u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey,
        );
      }
    } else if (cmd.command === "closePath") {
      push(sx, sy);
      if (cur.length) subs.push(cur);
      cur = [];
    }
  }
  if (cur.length) subs.push(cur);
  return subs.filter((sub) => sub.length > 1);
}

function glyphMask(ch: string, pixelSize: number): Mask {
  const key = `${pixelSize}:${ch}`;
  const cached = masks.get(key);
  if (cached) return cached;
  const code = ch.codePointAt(0) ?? 0;
  const { cjk, latin } = fonts();
  const face = cjk.glyphForCodePoint(code).id !== 0 ? cjk : latin;
  const glyph = face.glyphForCodePoint(code);
  if (glyph.id === 0) throw new IdWatermarkError(`watermark glyph missing ${ch}`);
  const scale = pixelSize / face.unitsPerEm;
  const advance = Math.max(1, glyph.advanceWidth * scale);
  const subs = contours(glyph.path);
  if (!subs.length) {
    const blank: Mask = { width: 0, height: 0, ox: 0, oy: 0, advance, alpha: new Uint8Array(0) };
    masks.set(key, blank);
    return blank;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sub of subs) {
    for (const [px, py] of sub) {
      minX = Math.min(minX, px);
      maxX = Math.max(maxX, px);
      minY = Math.min(minY, py);
      maxY = Math.max(maxY, py);
    }
  }
  const width = Math.max(1, Math.ceil((maxX - minX) * scale) + 1);
  const height = Math.max(1, Math.ceil((maxY - minY) * scale) + 1);
  const alpha = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const fy = maxY - row / scale;
    const hits: { x: number; dir: number }[] = [];
    for (const sub of subs) {
      for (let index = 0; index < sub.length - 1; index += 1) {
        const [x1, y1] = sub[index] ?? [0, 0];
        const [x2, y2] = sub[index + 1] ?? [0, 0];
        if (y1 === y2) continue;
        const yMin = Math.min(y1, y2);
        const yMax = Math.max(y1, y2);
        if (fy < yMin || fy >= yMax) continue;
        const t = (fy - y1) / (y2 - y1);
        hits.push({ x: x1 + t * (x2 - x1), dir: y2 > y1 ? 1 : -1 });
      }
    }
    hits.sort((left, right) => left.x - right.x);
    let winding = 0;
    let from = 0;
    for (const hit of hits) {
      if (winding !== 0) {
        const start = Math.max(0, Math.floor((from - minX) * scale));
        const end = Math.min(width, Math.ceil((hit.x - minX) * scale));
        for (let col = start; col < end; col += 1) alpha[row * width + col] = 255;
      }
      winding += hit.dir;
      from = hit.x;
    }
  }
  const mask: Mask = { width, height, ox: minX * scale, oy: -maxY * scale, advance, alpha };
  masks.set(key, mask);
  return mask;
}

function blend(data: Uint8Array, index: number, alpha: number) {
  const cover = (alpha / 255) * 0.55;
  const keep = 1 - cover;
  data[index] = Math.round((data[index] ?? 0) * keep + 176 * cover);
  data[index + 1] = Math.round((data[index + 1] ?? 0) * keep + 72 * cover);
  data[index + 2] = Math.round((data[index + 2] ?? 0) * keep + 64 * cover);
  data[index + 3] = 255;
}

function paint(data: Uint8Array, width: number, height: number, text: string) {
  const pixelSize = Math.max(16, Math.min(72, Math.round(Math.min(width, height) / 22)));
  const glyphs = [...text].map((ch) => glyphMask(ch, pixelSize));
  const gap = pixelSize * 0.08;
  const lineWidth = glyphs.reduce((sum, mask) => sum + mask.advance, 0) + gap * Math.max(0, glyphs.length - 1);
  const stepX = lineWidth + pixelSize * 2;
  const stepY = pixelSize * 3.2;
  const angle = (-28 * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const cx = width / 2;
  const cy = height / 2;
  const span = Math.hypot(width, height);
  for (let y = -span; y <= span; y += stepY) {
    for (let x = -span; x <= span; x += stepX) {
      let pen = x;
      for (const mask of glyphs) {
        if (mask.width > 0) {
          for (let row = 0; row < mask.height; row += 1) {
            for (let col = 0; col < mask.width; col += 1) {
              const alpha = mask.alpha[row * mask.width + col] ?? 0;
              if (!alpha) continue;
              const lx = pen + mask.ox + col;
              const ly = y + mask.oy + row;
              const dx = lx - cx;
              const dy = ly - cy;
              const px = Math.round(cx + cos * dx - sin * dy);
              const py = Math.round(cy + sin * dx + cos * dy);
              if (px < 0 || py < 0 || px >= width || py >= height) continue;
              blend(data, (py * width + px) * 4, alpha);
            }
          }
        }
        pen += mask.advance + gap;
      }
    }
  }
  const bar = Math.min(height, Math.max(1, Math.min(14, Math.round(height * 0.02))));
  for (let y = height - bar; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = 176;
      data[index + 1] = 72;
      data[index + 2] = 64;
      data[index + 3] = 255;
    }
  }
}

function pixelsOf(bytes: Buffer) {
  const kind = sniffIdImage(bytes);
  if (kind === "jpeg") {
    try {
      const raw = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true, maxMemoryUsageInMB: 64 });
      return { width: raw.width, height: raw.height, data: Uint8Array.from(raw.data) };
    } catch {
      throw new IdWatermarkError("jpeg");
    }
  }
  if (kind === "png") {
    try {
      const raw = PNG.sync.read(bytes);
      return { width: raw.width, height: raw.height, data: Uint8Array.from(raw.data) };
    } catch {
      throw new IdWatermarkError("png");
    }
  }
  throw new IdWatermarkError("type");
}

/** JPEG with the fixed org sentence burned in. The original bytes are not returned. */
export function burnFixedIdWatermark(plain: Buffer, text: string) {
  const line = text.trim();
  if (!line.startsWith("僅供") || !line.endsWith("核對租約身分使用")) throw new IdWatermarkError("sentence");
  if ((line.match(/・/g) ?? []).length >= 2) throw new IdWatermarkError("sentence");
  const image = pixelsOf(plain);
  if (!image.width || !image.height || image.data.length !== image.width * image.height * 4) {
    throw new IdWatermarkError("pixels");
  }
  paint(image.data, image.width, image.height, line);
  let quality = 82;
  let encoded = encodeJpeg({ data: image.data, width: image.width, height: image.height }, quality);
  while (encoded.data.length > MAX_PHOTO_BYTES && quality > 8) {
    quality -= 8;
    encoded = encodeJpeg({ data: image.data, width: image.width, height: image.height }, quality);
  }
  if (encoded.data.length < 32 || encoded.data.length > MAX_PHOTO_BYTES) throw new IdWatermarkError("size");
  const out = Buffer.from(encoded.data);
  if (out.equals(plain)) throw new IdWatermarkError("unchanged");
  return out;
}

export function burnFixedIdCopy(plain: Buffer, firm: string) {
  return burnFixedIdWatermark(plain, idFixedWatermark(firm));
}
