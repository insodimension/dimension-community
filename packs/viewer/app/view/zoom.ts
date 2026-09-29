// The toolbar's zoom ladder. Renderers take an ABSOLUTE factor (1 = the layout
// they mounted at); the toolbar owns the steps and the limits.
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
const EPSILON = 0.005;

/** The next rung above (`in`) or below (`out`) `current`, which need not be a rung itself. */
export function stepZoom(current: number, direction: "in" | "out"): number {
	if (direction === "in") return STEPS.find(step => step > current + EPSILON) ?? MAX_ZOOM;
	return [...STEPS].reverse().find(step => step < current - EPSILON) ?? MIN_ZOOM;
}
