// Written for the Browser pack (matrix F6): OMP shrinks a cmux surface's screenshot to at most 1024 pixels on the longest edge with `Bun.Image` (`cmux-tab.ts` screenshot, `resizeImage` with maxWidth/maxHeight 1024); Node has no image library, so the PNG the cmux daemon returns is shrunk here.

/**
 * A PNG shrunk by whole-pixel averaging, in pure JavaScript (`node:zlib` only). Reads what a WKWebView snapshot is: non-interlaced, 8 bits per channel, grey, grey with alpha, RGB or
 * RGBA. Anything else (palette, 16 bits, interlaced, a corrupt file) is NOT guessed at: it comes back as it was, with a note saying the picture was not shrunk, so the model is never told
 * a picture was resized when it was not.
 */
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** The longest edge of the picture a model is given (OMP's resizeImage maxWidth and maxHeight). */
export const MODEL_PICTURE_EDGE = 1024;

export interface DownscaledPng {
	/** The PNG to give the model: shrunk, or the original when it already fits or could not be read. */
	buffer: Buffer;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	/** Set when the picture could not be shrunk and is larger than the model's edge. */
	note?: string;
}

interface Header {
	width: number;
	height: number;
	channels: number;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Buffer): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc32(body), 8 + data.length);
	return out;
}

/** The image size of a PNG, or undefined when the bytes are not one. */
export function pngSize(png: Buffer): { width: number; height: number } | undefined {
	if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") return undefined;
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function readHeader(png: Buffer): Header | undefined {
	const size = pngSize(png);
	if (!size) return undefined;
	const bitDepth = png[24];
	const colorType = png[25];
	const interlace = png[28];
	if (bitDepth !== 8 || interlace !== 0) return undefined;
	const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number | undefined>)[colorType!];
	return channels === undefined ? undefined : { ...size, channels };
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** The raw pixel rows of `png` (filters undone), or undefined for a file that does not decode. */
function decode(png: Buffer, header: Header): Buffer | undefined {
	const idat: Buffer[] = [];
	for (let at = 8; at + 12 <= png.length; ) {
		const length = png.readUInt32BE(at);
		const type = png.toString("latin1", at + 4, at + 8);
		if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
		if (type === "IEND") break;
		at += 12 + length;
	}
	let raw: Buffer;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return undefined;
	}
	const stride = header.width * header.channels;
	if (raw.length < (stride + 1) * header.height) return undefined;
	const pixels = Buffer.alloc(stride * header.height);
	for (let y = 0; y < header.height; y++) {
		const filter = raw[y * (stride + 1)]!;
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x++) {
			const left = x >= header.channels ? pixels[y * stride + x - header.channels]! : 0;
			const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
			const upLeft = y > 0 && x >= header.channels ? pixels[(y - 1) * stride + x - header.channels]! : 0;
			const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : -1;
			if (predicted < 0) return undefined;
			pixels[y * stride + x] = (line[x]! + predicted) & 0xff;
		}
	}
	return pixels;
}

function encode(pixels: Buffer, width: number, height: number, channels: number, colorType: number): Buffer {
	const stride = width * channels;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = colorType;
	return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Encode raw 8-bit pixels as a PNG (grey, grey+alpha, RGB or RGBA by `channels`): what the tests build their pictures with. */
export function encodePng(pixels: Buffer, width: number, height: number, channels: 1 | 2 | 3 | 4): Buffer {
	return encode(pixels, width, height, channels, { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]);
}

/** `png` shrunk so its longest edge is at most `edge` (default 1024), or as it is when it already fits or cannot be read. */
export function downscalePng(png: Buffer, edge: number = MODEL_PICTURE_EDGE): DownscaledPng {
	const size = pngSize(png);
	if (!size) return { buffer: png, width: 0, height: 0, originalWidth: 0, originalHeight: 0, note: "the picture is not a PNG the pack can read; it is sent as it is" };
	const whole: DownscaledPng = { buffer: png, ...size, originalWidth: size.width, originalHeight: size.height };
	if (Math.max(size.width, size.height) <= edge) return whole;
	const unreadable = { ...whole, note: `the picture is ${size.width}x${size.height} and this PNG encoding is not one the pack can shrink; it is sent at full size` };
	const header = readHeader(png);
	if (!header) return unreadable;
	const pixels = decode(png, header);
	if (!pixels) return unreadable;
	const ratio = edge / Math.max(size.width, size.height);
	const width = Math.max(1, Math.round(size.width * ratio));
	const height = Math.max(1, Math.round(size.height * ratio));
	const { channels } = header;
	const out = Buffer.alloc(width * height * channels);
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor((y * size.height) / height);
		const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * size.height) / height));
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor((x * size.width) / width);
			const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * size.width) / width));
			for (let c = 0; c < channels; c++) {
				let sum = 0;
				for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += pixels[(yy * size.width + xx) * channels + c]!;
				out[(y * width + x) * channels + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
			}
		}
	}
	return { buffer: encode(out, width, height, channels, png[25]!), width, height, originalWidth: size.width, originalHeight: size.height };
}
