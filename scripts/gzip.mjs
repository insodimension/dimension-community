import * as zlib from "node:zlib";

const WINDOW_SIZE = 32768;
const WINDOW_MASK = WINDOW_SIZE - 1;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const SHORT_MATCH_MAX_DISTANCE = 4096;
const HASH_BITS = 15;
const HASH_MASK = (1 << HASH_BITS) - 1;
const MAX_CHAIN = 256;
const NICE_MATCH = 258;
const BLOCK_SYMBOLS = 16384;
const STORED_BLOCK_MAX = 65535;
const END_OF_BLOCK = 256;
const LITLEN_SYMBOLS = 286;
const DIST_SYMBOLS = 30;
const CODE_LENGTH_SYMBOLS = 19;
const MAX_CODE_BITS = 15;
const MAX_CODE_LENGTH_BITS = 7;
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const GZIP_HEADER = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255];

const LENGTH_CODE = new Uint8Array(MAX_MATCH + 1);
for (let code = 0; code < LENGTH_BASE.length; code++) {
	const end = code + 1 < LENGTH_BASE.length ? LENGTH_BASE[code + 1] : MAX_MATCH + 1;
	for (let length = LENGTH_BASE[code]; length < end; length++) LENGTH_CODE[length] = code;
}
LENGTH_CODE[MAX_MATCH] = LENGTH_BASE.length - 1;
const DIST_CODE = new Uint8Array(WINDOW_SIZE + 1);
for (let code = 0; code < DIST_BASE.length; code++) {
	const end = code + 1 < DIST_BASE.length ? DIST_BASE[code + 1] : WINDOW_SIZE + 1;
	for (let distance = DIST_BASE[code]; distance < end; distance++) DIST_CODE[distance] = code;
}

class BitWriter {
	bytes;
	length = 0;
	#bits = 0;
	#count = 0;

	constructor(capacity) {
		this.bytes = new Uint8Array(Math.max(capacity, 1024));
	}

	#reserve(extra) {
		if (this.length + extra <= this.bytes.length) return;
		const grown = new Uint8Array(Math.max(this.bytes.length * 2, this.length + extra));
		grown.set(this.bytes.subarray(0, this.length));
		this.bytes = grown;
	}

	write(value, count) {
		this.#bits |= value << this.#count;
		this.#count += count;
		this.#reserve(4);
		while (this.#count >= 8) {
			this.bytes[this.length++] = this.#bits & 0xff;
			this.#bits >>>= 8;
			this.#count -= 8;
		}
	}

	alignToByte() {
		if (this.#count > 0) this.write(0, 8 - this.#count);
	}

	writeBytes(source) {
		this.#reserve(source.length);
		this.bytes.set(source, this.length);
		this.length += source.length;
	}
}

function huffmanLengths(frequencies) {
	const lengths = new Uint8Array(frequencies.length);
	const leaves = [];
	for (let symbol = 0; symbol < frequencies.length; symbol++) if (frequencies[symbol] > 0) leaves.push(symbol);
	if (leaves.length === 0) return lengths;
	if (leaves.length === 1) {
		lengths[leaves[0]] = 1;
		lengths[leaves[0] === 0 ? 1 : 0] = 1;
		return lengths;
	}
	leaves.sort((left, right) => frequencies[left] - frequencies[right] || left - right);
	const nodeCount = leaves.length * 2 - 1;
	const weight = new Float64Array(nodeCount);
	const parent = new Int32Array(nodeCount).fill(-1);
	leaves.forEach((symbol, index) => {
		weight[index] = frequencies[symbol];
	});
	let leafCursor = 0;
	let internalCursor = leaves.length;
	let next = leaves.length;
	const takeSmallest = () => {
		if (leafCursor < leaves.length && (internalCursor >= next || weight[leafCursor] <= weight[internalCursor])) return leafCursor++;
		return internalCursor++;
	};
	while (next < nodeCount) {
		const left = takeSmallest();
		const right = takeSmallest();
		weight[next] = weight[left] + weight[right];
		parent[left] = next;
		parent[right] = next;
		next++;
	}
	const depth = new Uint8Array(nodeCount);
	for (let node = nodeCount - 2; node >= 0; node--) depth[node] = depth[parent[node]] + 1;
	leaves.forEach((symbol, index) => {
		lengths[symbol] = depth[index];
	});
	return lengths;
}

function limitedLengths(frequencies, maxBits) {
	let scaled = frequencies;
	for (;;) {
		const lengths = huffmanLengths(scaled);
		if (lengths.every(length => length <= maxBits)) return lengths;
		scaled = scaled.map(frequency => (frequency > 0 ? Math.max(1, frequency >>> 1) : 0));
	}
}

function canonicalCodes(lengths) {
	const lengthCount = new Uint16Array(MAX_CODE_BITS + 1);
	for (const length of lengths) if (length > 0) lengthCount[length]++;
	const nextCode = new Uint16Array(MAX_CODE_BITS + 2);
	for (let bits = 1, code = 0; bits <= MAX_CODE_BITS; bits++) {
		code = (code + lengthCount[bits - 1]) << 1;
		nextCode[bits] = code;
	}
	const codes = new Uint16Array(lengths.length);
	lengths.forEach((length, symbol) => {
		if (length === 0) return;
		let code = nextCode[length]++;
		let reversed = 0;
		for (let bit = 0; bit < length; bit++) {
			reversed = (reversed << 1) | (code & 1);
			code >>>= 1;
		}
		codes[symbol] = reversed;
	});
	return codes;
}

function runLengthCodeLengths(lengths) {
	const symbols = [];
	for (let index = 0; index < lengths.length; ) {
		const value = lengths[index];
		let run = 1;
		while (index + run < lengths.length && lengths[index + run] === value) run++;
		index += run;
		if (value === 0) {
			while (run >= 11) {
				const take = Math.min(run, 138);
				symbols.push([18, take - 11, 7]);
				run -= take;
			}
			if (run >= 3) {
				symbols.push([17, run - 3, 3]);
				run = 0;
			}
		} else {
			symbols.push([value, 0, 0]);
			run--;
			while (run >= 3) {
				const take = Math.min(run, 6);
				symbols.push([16, take - 3, 2]);
				run -= take;
			}
		}
		for (; run > 0; run--) symbols.push([value, 0, 0]);
	}
	return symbols;
}

class BlockEncoder {
	#out;
	#input;
	#literals = new Uint16Array(BLOCK_SYMBOLS);
	#distances = new Uint16Array(BLOCK_SYMBOLS);
	#count = 0;
	#blockStart = 0;

	constructor(out, input) {
		this.#out = out;
		this.#input = input;
	}

	get full() {
		return this.#count === BLOCK_SYMBOLS;
	}

	literal(byte) {
		this.#literals[this.#count] = byte;
		this.#distances[this.#count++] = 0;
	}

	match(length, distance) {
		this.#literals[this.#count] = length;
		this.#distances[this.#count++] = distance;
	}

	flush(blockEnd, final) {
		const litFrequencies = new Uint32Array(LITLEN_SYMBOLS);
		const distFrequencies = new Uint32Array(DIST_SYMBOLS);
		let extraBits = 0;
		for (let index = 0; index < this.#count; index++) {
			const distance = this.#distances[index];
			if (distance === 0) {
				litFrequencies[this.#literals[index]]++;
				continue;
			}
			const lengthCode = LENGTH_CODE[this.#literals[index]];
			const distCode = DIST_CODE[distance];
			litFrequencies[257 + lengthCode]++;
			distFrequencies[distCode]++;
			extraBits += LENGTH_EXTRA[lengthCode] + DIST_EXTRA[distCode];
		}
		litFrequencies[END_OF_BLOCK]++;
		const litLengths = limitedLengths(litFrequencies, MAX_CODE_BITS);
		const distLengths = limitedLengths(distFrequencies, MAX_CODE_BITS);
		if (distLengths.every(length => length === 0)) distLengths[0] = 1;
		let litCount = LITLEN_SYMBOLS;
		while (litCount > 257 && litLengths[litCount - 1] === 0) litCount--;
		let distCount = DIST_SYMBOLS;
		while (distCount > 1 && distLengths[distCount - 1] === 0) distCount--;
		const combined = new Uint8Array(litCount + distCount);
		combined.set(litLengths.subarray(0, litCount));
		combined.set(distLengths.subarray(0, distCount), litCount);
		const runs = runLengthCodeLengths(combined);
		const codeLengthFrequencies = new Uint32Array(CODE_LENGTH_SYMBOLS);
		for (const [symbol] of runs) codeLengthFrequencies[symbol]++;
		const codeLengthLengths = limitedLengths(codeLengthFrequencies, MAX_CODE_LENGTH_BITS);
		let codeLengthCount = CODE_LENGTH_SYMBOLS;
		while (codeLengthCount > 4 && codeLengthLengths[CODE_LENGTH_ORDER[codeLengthCount - 1]] === 0) codeLengthCount--;

		let dynamicBits = 3 + 14 + 3 * codeLengthCount + extraBits;
		for (const [symbol, , extra] of runs) dynamicBits += codeLengthLengths[symbol] + extra;
		for (let symbol = 0; symbol < LITLEN_SYMBOLS; symbol++) dynamicBits += litFrequencies[symbol] * litLengths[symbol];
		for (let symbol = 0; symbol < DIST_SYMBOLS; symbol++) dynamicBits += distFrequencies[symbol] * distLengths[symbol];
		const storedLength = blockEnd - this.#blockStart;
		const storedBits = (Math.max(1, Math.ceil(storedLength / STORED_BLOCK_MAX)) * (3 + 7 + 32)) + storedLength * 8;

		if (storedBits <= dynamicBits) this.#writeStored(blockEnd, final);
		else this.#writeDynamic({ final, litLengths, distLengths, litCount, distCount, runs, codeLengthLengths, codeLengthCount });
		this.#count = 0;
		this.#blockStart = blockEnd;
	}

	#writeStored(blockEnd, final) {
		const out = this.#out;
		let start = this.#blockStart;
		do {
			const length = Math.min(STORED_BLOCK_MAX, blockEnd - start);
			const last = start + length === blockEnd;
			out.write(final && last ? 1 : 0, 1);
			out.write(0, 2);
			out.alignToByte();
			out.write(length & 0xff, 8);
			out.write(length >>> 8, 8);
			out.write(~length & 0xff, 8);
			out.write((~length >>> 8) & 0xff, 8);
			out.writeBytes(this.#input.subarray(start, start + length));
			start += length;
		} while (start < blockEnd);
	}

	#writeDynamic({ final, litLengths, distLengths, litCount, distCount, runs, codeLengthLengths, codeLengthCount }) {
		const out = this.#out;
		const litCodes = canonicalCodes(litLengths);
		const distCodes = canonicalCodes(distLengths);
		const codeLengthCodes = canonicalCodes(codeLengthLengths);
		out.write(final ? 1 : 0, 1);
		out.write(2, 2);
		out.write(litCount - 257, 5);
		out.write(distCount - 1, 5);
		out.write(codeLengthCount - 4, 4);
		for (let index = 0; index < codeLengthCount; index++) out.write(codeLengthLengths[CODE_LENGTH_ORDER[index]], 3);
		for (const [symbol, extra, extraBits] of runs) {
			out.write(codeLengthCodes[symbol], codeLengthLengths[symbol]);
			if (extraBits > 0) out.write(extra, extraBits);
		}
		for (let index = 0; index < this.#count; index++) {
			const distance = this.#distances[index];
			const value = this.#literals[index];
			if (distance === 0) {
				out.write(litCodes[value], litLengths[value]);
				continue;
			}
			const lengthCode = LENGTH_CODE[value];
			out.write(litCodes[257 + lengthCode], litLengths[257 + lengthCode]);
			if (LENGTH_EXTRA[lengthCode] > 0) out.write(value - LENGTH_BASE[lengthCode], LENGTH_EXTRA[lengthCode]);
			const distCode = DIST_CODE[distance];
			out.write(distCodes[distCode], distLengths[distCode]);
			if (DIST_EXTRA[distCode] > 0) out.write(distance - DIST_BASE[distCode], DIST_EXTRA[distCode]);
		}
		out.write(litCodes[END_OF_BLOCK], litLengths[END_OF_BLOCK]);
	}
}

function deflateRaw(input, out) {
	const size = input.length;
	const head = new Int32Array(1 << HASH_BITS).fill(-1);
	const previous = new Int32Array(WINDOW_SIZE);
	const encoder = new BlockEncoder(out, input);
	const hashAt = position => ((input[position] << 10) ^ (input[position + 1] << 5) ^ input[position + 2]) & HASH_MASK;
	const insert = position => {
		const hash = hashAt(position);
		previous[position & WINDOW_MASK] = head[hash];
		head[hash] = position;
	};
	let bestLength = 0;
	let bestDistance = 0;
	const findMatch = (position, mustBeat) => {
		bestLength = mustBeat;
		bestDistance = 0;
		const limit = Math.min(MAX_MATCH, size - position);
		let candidate = head[hashAt(position)];
		for (let chain = MAX_CHAIN; candidate >= 0 && position - candidate <= WINDOW_SIZE && chain > 0; chain--) {
			if (input[candidate + bestLength] === input[position + bestLength] && input[candidate] === input[position]) {
				let length = 0;
				while (length < limit && input[candidate + length] === input[position + length]) length++;
				if (length > bestLength) {
					bestLength = length;
					bestDistance = position - candidate;
					if (length >= NICE_MATCH || length === limit) break;
				}
			}
			const next = previous[candidate & WINDOW_MASK];
			if (next >= candidate) break;
			candidate = next;
		}
		if (bestDistance === 0 || (bestLength === MIN_MATCH && bestDistance > SHORT_MATCH_MAX_DISTANCE)) bestLength = 0;
	};
	const emit = (kind, position, length, distance) => {
		if (kind === 0) encoder.literal(input[position]);
		else encoder.match(length, distance);
		if (encoder.full) encoder.flush(position + (kind === 0 ? 1 : length), false);
	};

	let position = 0;
	let pendingLength = 0;
	let pendingDistance = 0;
	while (position < size) {
		let length = 0;
		let distance = 0;
		if (position + MIN_MATCH <= size) {
			findMatch(position, Math.max(pendingLength, MIN_MATCH - 1));
			length = bestLength;
			distance = bestDistance;
			insert(position);
		}
		if (pendingLength > 0) {
			if (length > pendingLength) {
				emit(0, position - 1);
				pendingLength = length;
				pendingDistance = distance;
				position++;
				continue;
			}
			emit(1, position - 1, pendingLength, pendingDistance);
			const end = position - 1 + pendingLength;
			for (let skipped = position + 1; skipped < end; skipped++) if (skipped + MIN_MATCH <= size) insert(skipped);
			position = end;
			pendingLength = 0;
			continue;
		}
		if (length >= MIN_MATCH) {
			pendingLength = length;
			pendingDistance = distance;
			position++;
			continue;
		}
		emit(0, position);
		position++;
	}
	if (pendingLength > 0) emit(1, position - 1, pendingLength, pendingDistance);
	encoder.flush(size, true);
	out.alignToByte();
}

export function deterministicGzip(input) {
	const out = new BitWriter((input.length >>> 1) + 64);
	out.writeBytes(GZIP_HEADER);
	deflateRaw(input, out);
	const trailer = new Uint8Array(8);
	const view = new DataView(trailer.buffer);
	view.setUint32(0, zlib.crc32(input) >>> 0, true);
	view.setUint32(4, input.length >>> 0, true);
	out.writeBytes(trailer);
	return Buffer.from(out.bytes.buffer, out.bytes.byteOffset, out.length);
}
