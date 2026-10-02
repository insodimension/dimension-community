// The pack's one structural guard. The page reads engine facts whose host types a pack bundle cannot
// import (it imports only the granted `@fraym/ui` surface), so its readers narrow with `typeof` on the
// fields they use; this proves only "an object", and every field stays `unknown` until checked.
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
