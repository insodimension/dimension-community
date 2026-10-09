// Written for the Browser pack (doc 77 §7.4.5). The server is started with its host's environment, and a code worker is a thread of the same process: the copy of `process.env` a worker is given is scrubbed (code-host.ts),
// but the process's own environment block is one block, and `process.report.getReport().environmentVariables` in a cell reads it whole (measured on the built bundle: TYPESAFE_API_KEY and a DIMENSION_* secret, from a
// cell of a second session). So the secrets the pack itself needs are taken out of the block once, at start, and kept here; a process the pack starts that needs them is handed them explicitly. Nothing a
// cell can reach (`process.env`, `process.report`, a child process's inherited environment) carries them afterwards.
//
// What this does not do: on Linux `/proc/self/environ` is the environment the process was started with, and unsetting a variable does not change it [INFERENCE from how the kernel exposes it; not run, there is no Linux
// here]. A host that must keep a secret from code in the same process has to pass it by another way than the environment. And a cell still reads the files (`credentials.key` among them), the network and other
// processes' command lines, as OMP's does: see doc 77 §7.4.5.

/** The keys the jev task agent needs in its environment (python/dim_browser_bridge/jev_task.py). */
const TASK_SECRETS: readonly string[] = ["TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY"];
/** A secret of the host's that is none of the pack's business. `DIMENSION_BROWSER_*` are the pack's own settings (`DIMENSION_BROWSER_ALLOW_PASSWORD_FIELDS` is a switch, not a secret). */
const FOREIGN_SECRET = /^DIMENSION_(?!BROWSER_)\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;

export class LaunchSecrets {
  #taken: Readonly<Record<string, string>> = {};

  /** Moves the pack's own secrets out of `env` into this store, and deletes every other secret of the host's that the pack does not use. Safe to call twice. */
  take(env: NodeJS.ProcessEnv = process.env): void {
    const taken: Record<string, string> = { ...this.#taken };
    for (const name of Object.keys(env)) {
      const own = TASK_SECRETS.find(secret => secret.toLowerCase() === name.toLowerCase());
      if (own === undefined && !FOREIGN_SECRET.test(name)) continue;
      const value = env[name];
      if (own !== undefined && value !== undefined) taken[own] = value;
      delete env[name];
    }
    this.#taken = taken;
  }

  /** A secret the pack was started with: the stored one, else whatever the environment holds now (a server that did not call `take`, such as a test's). */
  get(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    return this.#taken[name] ?? env[name];
  }

  /** The environment for a process the pack starts that needs its secrets (the task worker): `env` with the stored secrets in it. */
  environment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...env, ...this.#taken };
  }
}

/** The server's: `stdio.ts` calls `take` first thing, before anything can run a cell. */
export const launchSecrets = new LaunchSecrets();
