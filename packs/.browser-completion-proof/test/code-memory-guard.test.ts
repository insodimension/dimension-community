/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the one bound on what a cell allocates that does not wait for a look at an interval. The host's watchdog reads a worker's memory every 100 ms; a synchronous burst of
 * `Buffer.alloc(100e6)` commits 880 MB before the first read, and the desktop has been taken down by commit exhaustion more than once. The guard refuses the allocation that would pass the limit, before it is made, in the
 * cell, which can catch the error and goes on with its variables. The same guard in the shipped worker, on a real Node, is proven in code-bundle.test.ts; this holds its decisions on stand-in allocators, so the test
 * process's own globals are never touched.
 */
import { describe, expect, test } from "bun:test";
import { CellMemoryError, guardAllocations } from "../src/code/worker/memory-guard";

const MB = 1024 * 1024;

/** Allocators that make nothing and write down what they were asked for. */
function standIns() {
  const made: string[] = [];
  class ArrayBuffer {
    constructor(readonly length: number) {
      made.push(`ArrayBuffer ${length}`);
    }
  }
  class SharedArrayBuffer {
    constructor(readonly length: number) {
      made.push(`SharedArrayBuffer ${length}`);
    }
  }
  class Float64Array {
    static BYTES_PER_ELEMENT = 8;
    constructor(readonly length: number | ArrayBuffer) {
      made.push(`Float64Array ${String(length)}`);
    }
  }
  const Buffer = {
    alloc: (size: unknown) => (made.push(`alloc ${String(size)}`), { size }),
    allocUnsafe: (size: unknown) => (made.push(`allocUnsafe ${String(size)}`), { size }),
    allocUnsafeSlow: (size: unknown) => (made.push(`allocUnsafeSlow ${String(size)}`), { size }),
  };
  const scope: Record<string, any> = { ArrayBuffer, SharedArrayBuffer, Float64Array, Buffer };
  return { scope, made };
}

/** A worker that holds `heldMb` now, and a collection that frees `freedMb` of it. */
function worker(heldMb: number, freedMb = 0) {
  const state = { heldMb, reads: 0, collections: 0 };
  return {
    state,
    seams: {
      held: () => (state.reads++, state.heldMb * MB),
      collect: () => {
        state.collections += 1;
        state.heldMb -= freedMb;
      },
    },
  };
}

describe("the allocation guard", () => {
  test("an allocation that would take the worker past its limit is refused before it is made, and the refusal says what was held and where the limit is set", () => {
    const { scope, made } = standIns();
    const { seams } = worker(200);
    guardAllocations(scope, 300, seams);
    expect(() => scope.Buffer.alloc(150 * MB)).toThrow(CellMemoryError);
    expect(() => scope.Buffer.allocUnsafe(150 * MB)).toThrow(/holds 200 MB and the limit is 300 MB \(DIMENSION_BROWSER_CODE_MEMORY_MB\)/);
    expect(() => new scope.ArrayBuffer(150 * MB)).toThrow(CellMemoryError);
    expect(() => new scope.Float64Array(20 * MB)).toThrow(CellMemoryError); // 160 MB: the element size counts
    expect(made).toEqual([]);
    // Under the limit it goes through, to the real allocator.
    scope.Buffer.alloc(50 * MB);
    expect(made).toEqual([`alloc ${50 * MB}`]);
  });

  test("the refusal is a RangeError the cell can catch, named so the model reads what it is", () => {
    const { scope } = standIns();
    guardAllocations(scope, 300, worker(299).seams);
    let caught: unknown;
    try {
      scope.Buffer.alloc(20 * MB);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect((caught as Error).name).toBe("CellMemoryError");
  });

  test("garbage is not held: over the limit it collects first, and a worker that is under the limit once the garbage is gone is not refused", () => {
    const { scope, made } = standIns();
    const { seams, state } = worker(400, 350); // 400 MB held, 350 of them dropped by the collection
    guardAllocations(scope, 300, seams);
    scope.Buffer.alloc(100 * MB);
    expect(state.collections).toBe(1);
    expect(made).toEqual([`alloc ${100 * MB}`]);
    // Nothing to collect: refused.
    const stuck = standIns();
    guardAllocations(stuck.scope, 300, worker(400, 0).seams);
    expect(() => stuck.scope.Buffer.alloc(100 * MB)).toThrow(CellMemoryError);
  });

  test("a loop of small buffers does not read the heap each time: the worker is looked at once per 16 MB asked for, and at once for one allocation of that size", () => {
    const { scope } = standIns();
    const { seams, state } = worker(10);
    guardAllocations(scope, 300, seams);
    for (let i = 0; i < 10_000; i += 1) scope.Buffer.alloc(1024); // 10 MB in all
    expect(state.reads).toBe(0);
    for (let i = 0; i < 10_000; i += 1) scope.Buffer.alloc(1024); // 20 MB in all: one look
    expect(state.reads).toBe(1);
    scope.Buffer.alloc(16 * MB);
    expect(state.reads).toBe(2);
  });

  test("what is not a size is left to the real allocator, which says what is wrong with it", () => {
    const { scope, made } = standIns();
    // The worker is already far over its limit: only a real size can be refused.
    const { seams, state } = worker(9_999);
    guardAllocations(scope, 300, seams);
    for (const odd of ["999999999", -1, 0, Number.NaN, undefined, {}]) scope.Buffer.alloc(odd);
    expect(made).toHaveLength(6);
    expect(state.reads).toBe(0);
  });

  test("a SharedArrayBuffer is added up by the guard, because V8 does not count its memory: three of 100 MB are allowed and the fourth is refused at a limit of 300 MB", () => {
    const { scope } = standIns();
    guardAllocations(scope, 300, worker(10).seams); // V8 says 10 MB however many SharedArrayBuffers there are
    for (let i = 0; i < 2; i += 1) new scope.SharedArrayBuffer(100 * MB);
    expect(() => new scope.SharedArrayBuffer(100 * MB)).toThrow(CellMemoryError);
  });

  test("the wrapped constructors still behave as constructors: instanceof, a subclass, the constant on them, and `.constructor` of an instance all name the wrapper", () => {
    const { scope } = standIns();
    guardAllocations(scope, 300, worker(0).seams);
    const wrapped = scope.ArrayBuffer as new (length: number) => { length: number };
    const buffer = new wrapped(8);
    expect(buffer).toBeInstanceOf(wrapped);
    expect(buffer.constructor).toBe(wrapped);
    expect(scope.Float64Array.BYTES_PER_ELEMENT).toBe(8);
    class Mine extends (scope.Float64Array as new (length: number) => { length: number }) {}
    expect(new Mine(4).length).toBe(4);
    expect(() => (scope.ArrayBuffer as () => void)()).toThrow(TypeError); // still needs `new`
    expect(() => new (class extends (scope.Float64Array as new (length: number) => object) {})(40 * MB)).toThrow(CellMemoryError); // a subclass is asked about too
  });

  test("a view over an existing buffer allocates nothing and is never refused", () => {
    const { scope, made } = standIns();
    guardAllocations(scope, 300, worker(9_999).seams);
    const underlying = new scope.ArrayBuffer(8);
    expect(() => new scope.Float64Array(underlying)).not.toThrow();
    expect(made).toEqual(["ArrayBuffer 8", "Float64Array [object Object]"]);
  });
});
