import { LIBHEIF_ASSET } from "@/generated/libheif-asset";
import { PHOTO_HEADER_BYTES, PHOTO_MAX_BYTES, sniffPhotoMime } from "@/server/repair-rules";

type BrowserModule = { ready: Promise<unknown> };
type BrowserFactory = (options?: Record<string, unknown>) => BrowserModule;

let instancePromise: Promise<BrowserModule> | undefined;

async function loadInstance(): Promise<BrowserModule> {
  const factory = (await import(/* webpackIgnore: true */ LIBHEIF_ASSET.path) as {
    default: BrowserFactory;
  }).default;
  if (typeof factory !== "function") {
    throw new Error("Invalid HEIC browser module");
  }
  const libheif = factory();
  await libheif.ready;
  return libheif;
}

function browserInstance(): Promise<BrowserModule> {
  if (!instancePromise) {
    instancePromise = loadInstance().catch((error: unknown) => {
      instancePromise = undefined;
      throw error;
    });
  }
  return instancePromise;
}

/** Called only by the browser upload handler. */
export async function heicFileToJpeg(file: File): Promise<File> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("HEIC conversion requires a browser");
  }
  const canvas = document.createElement("canvas");
  if (typeof canvas.toBlob !== "function" || !canvas.getContext("2d")) {
    throw new Error("HEIC conversion requires canvas support");
  }
  const libheif = await browserInstance();
  const decodeLib = (await import("heic-decode/lib.js")).default(libheif);
  const formats = (await import("heic-convert/formats-browser.js")).default;
  const convertLib = (await import("heic-convert/lib.js")).default(decodeLib.one, formats);
  const output = await convertLib.one({
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
