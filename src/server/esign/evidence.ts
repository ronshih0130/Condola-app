import { deflateSync } from "node:zlib";
import { acceptableSignature, type Stroke, type Point } from "./rules";

/** Render accepted points on the server; never accept a PNG unrelated to them. */
export function signaturePng(strokes: readonly Stroke[]) {
  if (!Array.isArray(strokes) || strokes.length > 100 ||
      strokes.some((s) => !Array.isArray(s)) ||
      strokes.reduce((n, s) => n + s.length, 0) > 10000 ||
      !acceptableSignature(strokes) ||
      strokes.some((s) => s.some((p: Point) => p.x < 0 || p.x > 720 || p.y < 0 || p.y > 240))) {
    throw new Error("Invalid handwritten signature");
  }
  const width = 721, height = 241;
  const raw = new Uint8Array(height * (1 + width * 4));
  function dot(x: number, y: number) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const px = Math.round(x) + dx, py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const at = py * (1 + width * 4) + 1 + px * 4;
      raw[at] = raw[at + 1] = raw[at + 2] = 34;
      raw[at + 3] = 255;
    }
  }
  for (const stroke of strokes) for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1], b = stroke[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let k = 0; k <= steps; k++) dot(a.x + (b.x - a.x) * k / steps, a.y + (b.y - a.y) * k / steps);
  }
  function chunk(name: string, data: Uint8Array) {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(name, 4, 4, "ascii");
    result.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()),
  ]));
}
