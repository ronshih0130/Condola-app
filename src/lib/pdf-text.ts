import { inflateSync } from "node:zlib";

/** Inflate Flate streams so tests can see Helvetica text pdf-lib compressed. */
export function pdfDecoded(bytes: Uint8Array): Buffer {
  const raw = Buffer.from(bytes);
  const parts: Buffer[] = [raw];
  let cursor = 0;
  while (cursor < raw.length) {
    const marker = raw.indexOf("stream", cursor);
    if (marker < 0) break;
    let start = marker + "stream".length;
    if (raw[start] === 0x0d && raw[start + 1] === 0x0a) start += 2;
    else if (raw[start] === 0x0a) start += 1;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    let dataEnd = end;
    if (dataEnd > start && raw[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (dataEnd > start && raw[dataEnd - 1] === 0x0d) dataEnd -= 1;
    try {
      parts.push(inflateSync(raw.subarray(start, dataEnd)));
    } catch {
      // Not a Flate stream.
    }
    cursor = end + "endstream".length;
  }
  return Buffer.concat(parts);
}

export function pdfContainsAscii(bytes: Uint8Array, text: string) {
  const decoded = pdfDecoded(bytes);
  if (decoded.includes(Buffer.from(text, "latin1"))) return true;
  // pdf-lib writes WinAnsi text as hex bytes (`<6364>` for "cd"), not as a literal string.
  const hex = Buffer.from(text, "latin1").toString("hex");
  return decoded.toString("latin1").toLowerCase().includes(hex);
}
