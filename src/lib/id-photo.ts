import { ID_COMPRESS_JPEG_QUALITY, idCompressLongEdge } from "./id-compress";
import { nearWhiteShare, showsGlare } from "./idv";
import { embedIdWatermarkMark, ID_PHOTO_LONG_EDGE, ID_WATERMARK_MARK, MAX_PHOTO_BYTES } from "./jpeg-size";

/** Browser fonts that cover Traditional Chinese. No font file is shipped. */
export const CJK_FONT_STACK =
  '"PingFang TC", "PingFang SC", "Noto Sans CJK TC", "Noto Sans TC", "Microsoft JhengHei", "Heiti TC", sans-serif';

export class IdPhotoError extends Error {
  constructor(readonly code: "open" | "big") {
    super(code);
  }
}

export function taipeiDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new IdPhotoError("open"))), "image/jpeg", quality);
  });
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new IdPhotoError("open"));
    reader.readAsDataURL(blob);
  });
}

async function decodeBitmap(file: File) {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      throw new IdPhotoError("open");
    }
  }
}

function burnWatermark(ctx: CanvasRenderingContext2D, width: number, height: number, lines: readonly string[]) {
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((-28 * Math.PI) / 180);
  const fontSize = Math.max(18, Math.round(Math.min(width, height) / 22));
  ctx.font = `600 ${fontSize}px ${CJK_FONT_STACK}`;
  ctx.fillStyle = "rgba(176, 72, 64, 0.42)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const gap = fontSize * 1.3;
  const blockHeight = lines.length * gap;
  const blockWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), fontSize * 8) + fontSize * 3;
  const span = Math.hypot(width, height);
  for (let y = -span; y <= span; y += blockHeight + fontSize * 3.2) {
    for (let x = -span; x <= span; x += blockWidth) {
      lines.forEach((line, index) => ctx.fillText(line, x, y + index * gap));
    }
  }
  ctx.restore();
  const bar = Math.min(14, Math.max(4, Math.round(height * 0.02)));
  ctx.fillStyle = "#b04840";
  ctx.fillRect(0, height - bar, width, bar);
}

/**
 * Downscale and encode a JPEG. A non-empty `lines` list burns those pixels.
 * The upload path passes none: the server burns the fixed firm sentence into
 * a second copy. The COM marker is still embedded so upload can reject a JPEG
 * that skipped this step. The marker is not proof that the pixels were burned.
 * Compression (about 2000px, quality 0.8) runs only when `compress` is set.
 * Otherwise the long edge stays at ID_PHOTO_LONG_EDGE. Quality drops until the
 * file is within the upload cap. Smaller sources are not enlarged.
 */
export async function prepareIdPhoto(file: File, lines: readonly string[], options?: { compress?: boolean }) {
  const bitmap = await decodeBitmap(file);
  try {
    const compress = options?.compress === true;
    const edge = compress ? idCompressLongEdge() : ID_PHOTO_LONG_EDGE;
    const long = Math.max(bitmap.width, bitmap.height);
    const scale = long > edge ? edge / long : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new IdPhotoError("open");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const glare = showsGlare(nearWhiteShare(pixels));
    if (lines.length) burnWatermark(ctx, width, height, lines);
    let quality = compress ? ID_COMPRESS_JPEG_QUALITY : 0.8;
    let blob = await canvasBlob(canvas, quality);
    while (blob.size > MAX_PHOTO_BYTES && quality > 0.2) {
      quality = Math.round((quality - 0.1) * 10) / 10;
      blob = await canvasBlob(canvas, quality);
    }
    if (blob.size > MAX_PHOTO_BYTES) throw new IdPhotoError("big");
    const marked = embedIdWatermarkMark(new Uint8Array(await blob.arrayBuffer()), `${ID_WATERMARK_MARK}\n${lines.join("\n")}`);
    if (!marked) throw new IdPhotoError("open");
    return { dataUrl: await blobToDataUrl(new Blob([marked], { type: "image/jpeg" })), glare };
  } finally {
    bitmap.close();
  }
}
