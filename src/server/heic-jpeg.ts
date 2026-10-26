import { Buffer } from "node:buffer";
import convert from "heic-convert";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, sniffHeic, sniffPhotoMime } from "./repair-rules";
import { FlowError } from "./errors";

/**
 * The browser uploads the original HEIC file. This is the only place that
 * decodes it, and it stores a JPEG. JPEG, PNG, and WEBP are not re-encoded.
 */
export async function heicToJpeg(bytes: Uint8Array) {
  if (!sniffHeic(bytes.subarray(0, Math.min(bytes.length, 32)))) throw new FlowError("errors.photoHeic");
  if (bytes.byteLength > PHOTO_MAX_BYTES) throw new FlowError("errors.photoSize");
  let output: ArrayBuffer;
  try {
    output = await convert({ buffer: Buffer.from(bytes), format: "JPEG", quality: 0.9 });
  } catch {
    throw new FlowError("errors.photoHeic");
  }
  const jpeg = new Uint8Array(output);
  if (jpeg.byteLength <= 0 || jpeg.byteLength > PHOTO_MAX_BYTES) throw new FlowError("errors.photoSize");
  if (sniffPhotoMime(jpeg.subarray(0, PHOTO_HEADER_BYTES)) !== "image/jpeg") throw new FlowError("errors.photoHeic");
  return jpeg;
}
