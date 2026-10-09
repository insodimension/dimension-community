// Written for the Browser pack (doc 77 §7.4.4). The host looks at a worker's memory every `memoryPollMs` (session.ts) and ends the worker past its limit; a look at an interval cannot stop a synchronous burst of
// allocations, which commits 880 MB before the first look. This is the part that can say no: the allocations a cell makes itself (`Buffer.alloc`, `new ArrayBuffer`, `new Uint8Array(n)` and the other typed arrays,
// `new SharedArrayBuffer`) are asked about BEFORE they are made, and one that would take the worker past its limit throws in the cell, which can catch it, and allocates nothing.
//
// What the worker holds is read from V8 inside the worker (heap plus external memory, which is where an ArrayBuffer's backing store is counted: the same figure the host reads), at most once per `STRIDE` bytes
// asked for and at once for any allocation of that size, so a loop of small buffers pays almost nothing. Over the limit it collects garbage first and looks again: the refusal is for memory the cell holds, not for
// buffers it dropped a moment ago.
//
// What it does NOT cover, measured in the PR: memory a native module or Node's own internals allocate (`fs.readFileSync`, `crypto.randomBytes`, `zlib`, `Buffer.from(string)`), `WebAssembly.Memory`, and anything
// captured from the globals before the worker's `init` message. Those reach the host's watchdog only, which looks at an interval. It is a guard against a cell's own runaway, not a sandbox.

import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

const MB = 1024 * 1024;
/** Allocations are looked at together once they add up to this much: a look is a call into V8. */
const STRIDE = 16 * MB;
const TYPED_ARRAYS = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"] as const;

/** What a cell is told when an allocation would take its worker past the limit. A RangeError, as a failed allocation is anywhere else. */
export class CellMemoryError extends RangeError {
  override name = "CellMemoryError";
}

/** The worker's own heap plus its external memory (Buffers and ArrayBuffers), bytes. */
function heldBytes(): number {
  const { used_heap_size, external_memory } = getHeapStatistics();
  return used_heap_size + external_memory;
}

/** A full collection, asked for through the flag V8 reads at run time; the flag is put back before the collection runs. */
function collectGarbage(): void {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    setFlagsFromString("--no-expose-gc");
    gc();
  } catch {
    // No collection (a runtime without the flag): the refusal stands on the figure it has.
  }
}

interface Seams {
  held?: () => number;
  collect?: () => void;
}

/** Wraps the allocators of `scope` (the worker's globals) so that none takes the worker past `limitMb`. Call it once, in the worker thread, before any cell runs. */
export function guardAllocations(scope: Record<string, any>, limitMb: number, { held = heldBytes, collect = collectGarbage }: Seams = {}): void {
  const limit = limitMb * MB;
  let unseen = 0;
  // V8 does not count a SharedArrayBuffer's backing store as external memory (ten of 100 MB showed as 10 MB held), so the ones of a megabyte or more are added up here and never given back: they are rare.
  let shared = 0;
  // `label` and `asked` build the refusal's text only when there is one: this runs for every Buffer and typed array the worker makes, and a string built each time was most of what the guard cost.
  const admit = (bytes: number, label: string, asked: unknown): void => {
    unseen += bytes;
    if (unseen < STRIDE) return;
    unseen = 0;
    let now = held() + shared;
    if (now + bytes > limit) {
      collect();
      now = held() + shared;
    }
    if (now + bytes > limit) {
      throw new CellMemoryError(`${label}(${String(asked)}) was refused: this code worker holds ${Math.round(now / MB)} MB and the limit is ${limitMb} MB (DIMENSION_BROWSER_CODE_MEMORY_MB). Nothing was allocated and the cell's variables are intact. Free what you hold, or keep large data in a file and handle it in pieces.`);
    }
  };
  for (const name of ["alloc", "allocUnsafe", "allocUnsafeSlow"] as const) {
    const original = scope.Buffer[name] as (this: unknown, size: unknown, fill?: unknown, encoding?: unknown) => unknown;
    const label = `Buffer.${name}`;
    scope.Buffer[name] = {
      [name](this: unknown, size: unknown, fill?: unknown, encoding?: unknown): unknown {
        if (typeof size === "number" && size > 0) admit(size, label, size); // anything else is not a size: the real allocator says what is wrong with it
        return original.call(this, size, fill, encoding);
      },
    }[name];
  }
  // `prototype.constructor` points at the wrapper too, so `buffer.constructor === ArrayBuffer` still holds and a copy made through a species constructor is asked about like any other allocation.
  const wrap = (name: string): void => {
    const original = scope[name];
    if (typeof original !== "function") return;
    const unit: number = original.BYTES_PER_ELEMENT ?? 1;
    const label = `new ${name}`;
    const counted = name === "SharedArrayBuffer";
    scope[name] = new Proxy(original, {
      construct(target, args, newTarget) {
        const size: unknown = args[0];
        if (typeof size === "number" && size > 0) {
          admit(size * unit, label, size);
          if (counted && size >= MB) shared += size;
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
    Object.defineProperty(original.prototype, "constructor", { value: scope[name], writable: true, configurable: true });
  };
  for (const name of ["ArrayBuffer", "SharedArrayBuffer", ...TYPED_ARRAYS]) wrap(name);
}
