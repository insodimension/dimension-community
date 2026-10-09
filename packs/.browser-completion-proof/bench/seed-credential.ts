// Saves the bench profile's password for the practice origin through the pack's own credentials module, so the store is written the way
// the pack writes it (sealed under the root's key) whatever the profile already holds: a --root that was used before, a store from an
// older version. run.mjs runs this with bun and sends `{ root, profile, origin, password }` on stdin.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CredentialKey, saveCredential } from "../src/credentials";

const { root, profile, origin, password } = JSON.parse(await Bun.stdin.text()) as { root: string; profile: string; origin: string; password: string };
const dir = join(root, "profiles", profile);
mkdirSync(dir, { recursive: true, mode: 0o700 });
saveCredential(dir, origin, password, new CredentialKey(root));
