// Written for the Browser pack (no OMP counterpart): OMP reads the size of a screenshot back from Bun.Image; the code worker runs on Node, and the screenshot is
// encoded by Chrome, so the size is read from the image's own header. PNG and JPEG follow OMP's readPngHeaderDimensions / readJpegHeaderDimensions (utils/image-resize.ts).

export interface ImageDimensions {
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o]! << 8) | b[o + 1]!;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function u24le(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
}

function ascii(b: Uint8Array, o: number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]!);
  return s;
}

function png(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 24 || ascii(b, 1, 3) !== "PNG" || ascii(b, 12, 4) !== "IHDR") return undefined;
  const width = u32be(b, 16);
  const height = u32be(b, 20);
  return width > 0 && height > 0 ? { width, height, mimeType: "image/png" } : undefined;
}

function jpeg(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  let o = 2;
  while (o + 3 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    while (o < b.length && b[o] === 0xff) o++;
    if (o >= b.length) return undefined;
    const marker = b[o++]!;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (o + 1 >= b.length) return undefined;
    const length = u16be(b, o);
    if (length < 2) return undefined;
    const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (sof) {
      if (o + 7 >= b.length) return undefined;
      const height = u16be(b, o + 3);
      const width = u16be(b, o + 5);
      return width > 0 && height > 0 ? { width, height, mimeType: "image/jpeg" } : undefined;
    }
    o += length;
  }
  return undefined;
}

function webp(b: Uint8Array): ImageDimensions | undefined {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return undefined;
  const chunk = ascii(b, 12, 4);
  let width: number;
  let height: number;
  if (chunk === "VP8X") {
    width = u24le(b, 24) + 1;
    height = u24le(b, 27) + 1;
  } else if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return undefined;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    width = (b[26]! | (b[27]! << 8)) & 0x3fff;
    height = (b[28]! | (b[29]! << 8)) & 0x3fff;
  } else return undefined;
  return width > 0 && height > 0 ? { width, height, mimeType: "image/webp" } : undefined;
}

/** The pixel size and type of a PNG, JPEG or WebP, read from its header; undefined for anything else. */
export function readImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}
