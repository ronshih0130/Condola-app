import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, sniffPhotoMime } from "@/server/repair-rules";

/** Called only by the browser upload handler. */
export async function heicFileToJpeg(file: File): Promise<File> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("HEIC conversion requires a browser");
  }
  const canvas = document.createElement("canvas");
  if (typeof canvas.toBlob !== "function" || !canvas.getContext("2d")) {
    throw new Error("HEIC conversion requires canvas support");
  }
  const mod = await import("heic-convert/browser");
  const output = await mod.default({
    buffer: new Uint8Array(await file.arrayBuffer()),
    format: "JPEG",
    quality: 0.9,
  });
  if (output.byteLength <= 0 || output.byteLength > PHOTO_MAX_BYTES ||
      sniffPhotoMime(output.subarray(0, PHOTO_HEADER_BYTES)) !== "image/jpeg") {
    throw new Error("HEIC conversion did not produce an accepted JPEG");
  }
  return new File([new Uint8Array(output)], `${file.name.replace(/\.[^.]+$/, "")}.jpg`, { type: "image/jpeg" });
}
