/** Stored ID photos are baseline JPEGs, at most this many bytes. Progressive is rejected. */
export const MAX_PHOTO_BYTES = 800 * 1024;

/** Long edge while client compression is off. The server cap is wider so the compress target fits. */
export const ID_PHOTO_LONG_EDGE = 1600;

/** Longest edge the server stores. Matches the client compress target of about 2000px. */
export const MAX_LONG_EDGE = 2000;

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * Width and height from a JPEG SOF marker. Stops at the start of scan data,
 * so it does not decode pixels.
 */
export function readJpegSize(bytes: Uint8Array): { width: number; height: number; baseline: boolean } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9) return null;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return null;
    if (SOF.has(marker)) {
      if (length < 7) return null;
      const height = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
      const width = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      if (!width || !height) return null;
      // Baseline SOF0 only. Progressive scans can carry APP/EXIF between SOS
      // markers; rejecting them avoids keeping that metadata.
      return { width, height, baseline: marker === 0xc0 };
    }
    if (marker === 0xda) return null;
    offset += length;
  }
  return null;
}

/** True when the bytes are a JPEG the server is allowed to store. No pixel decode. */
export function acceptIdJpeg(bytes: Uint8Array) {
  if (bytes.length < 32 || bytes.length > MAX_PHOTO_BYTES) return false;
  const size = readJpegSize(bytes);
  if (!size?.baseline) return false;
  return Math.max(size.width, size.height) <= MAX_LONG_EDGE;
}

/** JPEG SOI or PNG signature. GIF and every other format return null. */
export function sniffIdImage(bytes: Uint8Array): "jpeg" | "png" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  return null;
}

function uint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] ?? 0) * 0x1000000) + ((bytes[offset + 1] ?? 0) << 16) + ((bytes[offset + 2] ?? 0) << 8) + (bytes[offset + 3] ?? 0);
}

/** PNG signature plus an IHDR that fits the same size cap as a JPEG. No pixel decode. */
export function acceptIdPng(bytes: Uint8Array) {
  if (sniffIdImage(bytes) !== "png" || bytes.length < 33 || bytes.length > MAX_PHOTO_BYTES) return false;
  const length = uint32(bytes, 8);
  const type = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (type !== "IHDR" || length !== 13) return false;
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  if (!width || !height) return false;
  return Math.max(width, height) <= MAX_LONG_EDGE;
}

/** A file the upload control may hand to the canvas. Magic bytes decide; the MIME type cannot widen that. */
export function idFileAllowed(type: string, head: Uint8Array) {
  const normalized = type.trim().toLowerCase();
  if (normalized && normalized !== "image/jpeg" && normalized !== "image/jpg" && normalized !== "image/png") return false;
  const sniffed = sniffIdImage(head);
  if (sniffed === "jpeg") return normalized === "" || normalized === "image/jpeg" || normalized === "image/jpg";
  if (sniffed === "png") return normalized === "" || normalized === "image/png";
  return false;
}

/** Base64 length that can decode to at most MAX_PHOTO_BYTES. Check this before decoding. */
export function maxJpegBase64Chars(maxBytes = MAX_PHOTO_BYTES) {
  return Math.ceil(maxBytes / 3) * 4;
}

/** COM payload the browser writes after it burns the watermark into the pixels. */
export const ID_WATERMARK_MARK = "condola-id-wm";

const STRIPPED_MARKERS = new Set<number>([0xfe]);
for (let marker = 0xe1; marker <= 0xef; marker += 1) STRIPPED_MARKERS.add(marker);

function concatBytes(chunks: Uint8Array[]) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Drop APP1–APP15 and COM segments. APP0, tables, and the scan stay.
 * Walks markers only, so it does not decode pixels.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9) {
      chunks.push(bytes.subarray(markerStart, offset));
      break;
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(bytes.subarray(markerStart, offset));
      continue;
    }
    if (offset + 1 >= bytes.length) return null;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return null;
    const segmentEnd = offset + length;
    if (SOF.has(marker) && marker !== 0xc0) return null;
    if (marker === 0xda) {
      const scan = scanThroughEoi(bytes, markerStart);
      if (!scan) return null;
      chunks.push(scan);
      return concatBytes(chunks);
    }
    if (!STRIPPED_MARKERS.has(marker)) chunks.push(bytes.subarray(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  return concatBytes(chunks);
}

/** SOS header plus entropy through EOI. Bytes after EOI are dropped. FF 00 is stuffed data. */
function scanThroughEoi(bytes: Uint8Array, markerStart: number) {
  let offset = markerStart;
  while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
  if (offset >= bytes.length) return null;
  offset += 1;
  if (offset + 1 >= bytes.length) return null;
  const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
  if (length < 2 || offset + length > bytes.length) return null;
  let index = offset + length;
  while (index + 1 < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1;
      continue;
    }
    const next = bytes[index + 1] ?? 0;
    if (next === 0x00) {
      index += 2;
      continue;
    }
    if (next === 0xff) {
      index += 1;
      continue;
    }
    if (next === 0xd9) return bytes.subarray(markerStart, index + 2);
    index += 2;
  }
  return null;
}

/** Insert a COM segment after SOI. The server requires it, then strips it. */
export function embedIdWatermarkMark(bytes: Uint8Array, note = ID_WATERMARK_MARK) {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const payload = new TextEncoder().encode(note);
  const length = payload.length + 2;
  if (length > 65535) return null;
  const com = new Uint8Array(4 + payload.length);
  com[0] = 0xff;
  com[1] = 0xfe;
  com[2] = length >> 8;
  com[3] = length & 0xff;
  com.set(payload, 4);
  const out = new Uint8Array(bytes.length + com.length);
  out.set(bytes.subarray(0, 2), 0);
  out.set(com, 2);
  out.set(bytes.subarray(2), 2 + com.length);
  return out;
}

/** True when a COM segment before the scan carries the watermark mark. */
export function jpegHasWatermarkMark(bytes: Uint8Array, note = ID_WATERMARK_MARK) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  const needle = new TextEncoder().encode(note);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return false;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return false;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 0xfe && segmentIncludes(bytes.subarray(offset + 2, offset + length), needle)) return true;
    offset += length;
  }
  return false;
}

function segmentIncludes(segment: Uint8Array, needle: Uint8Array) {
  if (needle.length === 0 || segment.length < needle.length) return false;
  for (let index = 0; index <= segment.length - needle.length; index += 1) {
    let match = true;
    for (let cursor = 0; cursor < needle.length; cursor += 1) {
      if (segment[index + cursor] !== needle[cursor]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
