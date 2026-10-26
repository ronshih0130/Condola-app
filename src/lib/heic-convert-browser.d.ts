declare module "heic-decode/lib.js" {
  interface DecodedImage {
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
  }

  type DecodeOne = (input: { buffer: Uint8Array }) => Promise<DecodedImage>;

  function createDecoder(module: unknown): {
    one: DecodeOne;
    all: (input: { buffer: Uint8Array }) => Promise<unknown>;
  };

  export default createDecoder;
}

declare module "heic-convert/formats-browser.js" {
  interface EncodeInput {
    width: number;
    height: number;
    data: Uint8Array | Uint8ClampedArray;
    quality?: number;
  }

  type Encoder = (input: EncodeInput) => Promise<Uint8Array>;

  const formats: Record<"JPEG" | "PNG", Encoder>;
  export default formats;
}

declare module "heic-convert/lib.js" {
  type DecodeOne = ReturnType<typeof import("heic-decode/lib.js").default>["one"];
  type Formats = typeof import("heic-convert/formats-browser.js").default;

  interface ConvertInput {
    buffer: Uint8Array;
    format: "JPEG" | "PNG";
    quality?: number;
  }

  function createConverter(decode: DecodeOne, formats: Formats): {
    one: (input: ConvertInput) => Promise<Uint8Array>;
    all: (input: ConvertInput) => Promise<unknown>;
  };

  export default createConverter;
}
