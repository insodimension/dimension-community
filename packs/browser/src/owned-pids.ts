// Written for the Browser pack (doc 77 §7.4.4, §7.8). The server starts processes whose end belongs to whoever started them: a browser's own close (a saved profile's Chrome is never hard-killed, a write to its logins
// could be cut), and, with the launch kinds, an application a cell opened for the person (documented as staying open). When the server has to end with a cell inside a call that cannot be interrupted, the sweep
// that ends what the cell left behind (reap.ts) must not touch any of those. Whoever starts such a process registers its pid here for as long as the process runs; the sweep asks.

export class OwnedPids {
  readonly #pids = new Set<number>();

  /** `pid` is owned from now; call the returned function (or let the process's exit do it) when it is not. */
  add(pid: number): () => void {
    this.#pids.add(pid);
    return () => void this.#pids.delete(pid);
  }

  has(pid: number): boolean {
    return this.#pids.has(pid);
  }
}

/** The processes of this server. The runtime registers every browser it launches; the launch kinds register an application that is left open. */
export const ownedPids = new OwnedPids();
