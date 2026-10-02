// Written for the Browser pack (doc 77 §7.4.4). The per-worker limit bounds one cell; it says nothing about ten sessions that each hold 1.4 GB, which is 14 GB of commit in the one server process (the desktop has been taken
// down by commit exhaustion more than once). The sessions report what their workers hold, from the same look that enforces the per-worker limit, and when the sum passes the host's limit the LARGEST worker is ended.
//
// A figure of the whole process (where a runtime cannot read a worker's own: `own: false`) is the same memory seen by every cell that runs, so those are not added up: the largest of them stands for all.

export interface Overrun {
  /** What the ended worker held, MB. */
  usedMb: number;
  /** What all the workers held together when it was ended, MB. */
  totalMb: number;
}

export interface Member {
  /** The latest figure for this worker. If it takes the total past the limit, the largest worker (this one or another) is ended through its `end`. */
  report(usedMb: number, own: boolean): void;
  /** The worker is gone; its figure no longer counts. */
  leave(): void;
}

interface Entry {
  usedMb: number;
  own: boolean;
  end(overrun: Overrun): void;
}

export class HostMemory {
  readonly #members = new Set<Entry>();

  /** `limitMb` 0 never ends anything. */
  constructor(readonly limitMb: number) {}

  /** A live worker joins; `end` ends it when it is the largest at the limit. */
  join(end: (overrun: Overrun) => void): Member {
    const entry: Entry = { usedMb: 0, own: true, end };
    this.#members.add(entry);
    return {
      report: (usedMb, own) => {
        entry.usedMb = usedMb;
        entry.own = own;
        this.#enforce();
      },
      leave: () => void this.#members.delete(entry),
    };
  }

  /** Own figures add up; the figures of the whole process stand for one measurement, the largest of them. */
  #total(): number {
    let own = 0;
    let shared = 0;
    for (const entry of this.#members) {
      if (entry.own) own += entry.usedMb;
      else shared = Math.max(shared, entry.usedMb);
    }
    return own + shared;
  }

  #enforce(): void {
    if (this.limitMb <= 0) return;
    let total = this.#total();
    while (total > this.limitMb && this.#members.size > 0) {
      let largest: Entry | undefined;
      for (const entry of this.#members) if (largest === undefined || entry.usedMb > largest.usedMb) largest = entry;
      if (largest === undefined) return;
      this.#members.delete(largest);
      largest.end({ usedMb: largest.usedMb, totalMb: Math.round(total) });
      total = this.#total();
    }
  }
}
