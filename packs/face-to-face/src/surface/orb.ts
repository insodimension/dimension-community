// The door's orb: a few hundred soft dots on a sunflower spiral, coloured coral to green by a slowly
// turning gradient field, breathing. Drawn with a 2D canvas from pre-rendered soft sprites, so a frame is
// ~360 drawImage calls on a 56 px canvas.

const DOTS = 360;
const STRAYS = 10;
const GOLDEN = 2.399963229728653;
const BUCKETS = 24;
const SPRITE_PX = 32;

/** Coral -> orange -> peach -> mint -> deep green, the palette of the launch video's orb and waveform. */
const STOPS: readonly (readonly [number, number, number])[] = [
	[226, 84, 52],
	[240, 134, 74],
	[246, 196, 146],
	[132, 214, 170],
	[58, 118, 88],
];

export function orbColor(c: number): [number, number, number] {
	const x = Math.min(1, Math.max(0, c)) * (STOPS.length - 1);
	const i = Math.min(STOPS.length - 2, Math.floor(x));
	const k = x - i;
	const a = STOPS[i];
	const b = STOPS[i + 1];
	return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

interface Dot {
	r0: number;
	a0: number;
	seed: number;
	size: number;
}

function makeSprites(): HTMLCanvasElement[] {
	return Array.from({ length: BUCKETS }, (_, i) => {
		const cv = document.createElement("canvas");
		cv.width = cv.height = SPRITE_PX;
		const g = cv.getContext("2d");
		if (g) {
			const [r, gg, b] = orbColor(i / (BUCKETS - 1)).map(Math.round);
			const grad = g.createRadialGradient(SPRITE_PX / 2, SPRITE_PX / 2, 0, SPRITE_PX / 2, SPRITE_PX / 2, SPRITE_PX / 2);
			grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
			grad.addColorStop(0.5, `rgba(${r},${gg},${b},0.75)`);
			grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
			g.fillStyle = grad;
			g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
		}
		return cv;
	});
}

export interface Orb {
	/** Draw the orb at animation time `t` seconds. */
	draw(t: number): void;
}

export function createOrb(canvas: HTMLCanvasElement, size: number, dpr: number): Orb | null {
	const g = canvas.getContext("2d");
	if (!g) return null;
	canvas.width = Math.round(size * dpr);
	canvas.height = Math.round(size * dpr);
	const half = size / 2;
	const radius = half - 6;
	const sprites = makeSprites();
	const dots: Dot[] = Array.from({ length: DOTS + STRAYS }, (_, i) => {
		if (i >= DOTS) {
			const k = i - DOTS;
			return { r0: radius * (1.08 + 0.2 * ((k * 0.37) % 1)), a0: k * 2.1, seed: k * 1.7, size: 0.9 };
		}
		return { r0: radius * Math.sqrt((i + 0.5) / DOTS), a0: i * GOLDEN, seed: i * 0.618034, size: 1.15 + 1.1 * (((i * 7919) % 97) / 97) };
	});

	return {
		draw(t) {
			g.setTransform(dpr, 0, 0, dpr, 0, 0);
			g.clearRect(0, 0, size, size);
			const breath = 1 + 0.035 * Math.sin(t * 1.1);
			// the gradient axis turns once in ~40 s
			const axis = t * 0.157 - 0.9;
			const ax = Math.cos(axis);
			const ay = Math.sin(axis);
			for (let i = 0; i < dots.length; i++) {
				const d = dots[i];
				const stray = i >= DOTS;
				const depth = stray ? 0.3 : Math.sqrt(Math.max(0, 1 - (d.r0 / radius) ** 2));
				// inner dots turn a little faster than the rim: the surface swirls instead of spinning
				const ang = d.a0 + t * (stray ? 0.05 : 0.11) * (1.15 - 0.6 * (d.r0 / radius));
				const r = d.r0 * breath * (1 + 0.05 * Math.sin(t * 0.9 + d.seed * 6.283));
				const x = half + Math.cos(ang) * r;
				const y = half + Math.sin(ang) * r;
				const field = ((x - half) * ax + (y - half) * ay) / radius;
				const c = 0.5 + 0.5 * Math.max(-1, Math.min(1, field * 1.1 + 0.25 * Math.sin(d.seed * 3 + t * 0.35)));
				const bucket = Math.round(c * (BUCKETS - 1));
				const s = d.size * (0.75 + 0.55 * depth) * (stray ? 1 : 1 + 0.12 * Math.sin(t * 1.7 + d.seed * 9)) * 2.4;
				g.globalAlpha = stray ? 0.55 : 0.5 + 0.5 * depth;
				g.drawImage(sprites[bucket], x - s / 2, y - s / 2, s, s);
			}
			g.globalAlpha = 1;
		},
	};
}
