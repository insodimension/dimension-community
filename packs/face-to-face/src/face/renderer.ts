// Raw WebGL2 screen-space halftone of the baked head, two passes a frame:
//
//   A. SPLAT: the head's ~9k baked surface points are posed in the vertex shader (ARKit pose -> morph deltas
//      from a texture, head pose, breathing, gaze, the orb -> face formation) and splatted as discs with the
//      depth test on into a small G-buffer that maps the grid's rectangle: colour + presence, ink + rim. Only
//      the nearest surface survives, so nothing behind the face ever shows through it.
//   B. DOTS: one point per cell of a square grid locked to the head anchor (halftone-grid.ts). Each reads the
//      G-buffer at its cell centre: dot radius carries the tone, colour samples the skin, and cells near the
//      silhouette thin out and scatter outward.
//
// The CPU uploads ~120 floats a frame; nothing is allocated per frame. 'high' and 'low' differ only in the
// grid pitch, the G-buffer density and the canvas resolution cap.
import { halftoneGrid, type HalftoneGrid } from "./halftone-grid";
import { DOT_FRAG, DOT_VERT, SPLAT_FRAG, SPLAT_VERT, TEX_W } from "./halftone-shaders";
import type { HeadAsset } from "./head-asset";
import { arkitIndex, POSE_SIZE, RIG_GAIN, RIG_MAX } from "./shapes";

const BLINK_L = arkitIndex("eyeBlinkLeft");
const BLINK_R = arkitIndex("eyeBlinkRight");

/** Everything the animator hands the renderer each frame. */
export interface FaceFrame {
	/** The 52-float ARKit pose (alphabetical, see shapes.ts). */
	weights: Float32Array;
	yaw: number;
	pitch: number;
	roll: number;
	/** -1 cool .. +1 warm; the slow "slight colour change". */
	warm: number;
	/** Hue rotation in radians around the grey axis (small). */
	hue: number;
	/** 0 orb of loose dots .. 1 formed face. */
	formation: number;
	/** 0..1: how far the mouth is open; fades in the mouth-interior dots. */
	mouthOpen: number;
	/** 0..1: edge dots loosen and scatter (thinking). */
	loosen: number;
	/** Breathing offset in metres (y). */
	breath: number;
	/** Eye direction, -1..1 each (x right, y up). */
	gazeX: number;
	gazeY: number;
}

export type FaceQuality = "high" | "low";

export interface FaceRendererOptions {
	dark: boolean;
	/** Crown-to-chin height as a fraction of canvas height. */
	headFraction?: number;
	/** Head anchor as a fraction of canvas width/height. */
	anchor?: [number, number];
	/** Multiplier on every morph delta on top of the per-shape rig table (shapes.ts). */
	morphGain?: number;
	quality?: FaceQuality;
}

export interface FaceRenderer {
	resize(cssWidth: number, cssHeight: number, dpr: number): void;
	setDark(dark: boolean): void;
	setQuality(quality: FaceQuality): void;
	draw(frame: FaceFrame, timeSec: number): void;
	dispose(): void;
}

/** Splat disc radius as a fraction of the baked row spacing: >= 0.64 closes the gap to the diagonal neighbour; the
 * margin covers the rows' jitter and the skin stretching under the morphs. */
const SPLAT = 1.1;
/** The head oval the surface dissolves outside of (no neck, as in the reference): its half height as a multiple of
 * half the crown-to-chin span, and its width over its height. */
const OVAL_REACH = 1.05;
const OVAL_ASPECT = 0.74;
/** Half size around the anchor, metres, of everything that can draw: the head, its scattered rim, the forming orb. */
const DRAW_EXTENT: [number, number] = [0.2, 0.22];
/** The most canvas pixels per CSS pixel the renderer will use, by quality. */
const MAX_RATIO_HIGH = 1.5;
const MAX_RATIO_LOW = 1.25;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
	const sh = gl.createShader(type);
	if (!sh) throw new Error("createShader failed");
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`face shader: ${gl.getShaderInfoLog(sh)}`);
	return sh;
}

function program(gl: WebGL2RenderingContext, vert: string, frag: string, attribs: string[] = []): WebGLProgram {
	const prog = gl.createProgram();
	if (!prog) throw new Error("createProgram failed");
	const vs = compile(gl, gl.VERTEX_SHADER, vert);
	const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	attribs.forEach((a, i) => gl.bindAttribLocation(prog, i, a));
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`face program: ${gl.getProgramInfoLog(prog)}`);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	return prog;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniforms(gl: WebGL2RenderingContext, prog: WebGLProgram, names: string[]): Uniforms {
	return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));
}

interface GBuffer {
	fbo: WebGLFramebuffer;
	/** premultiplied colour, presence */
	g0: WebGLTexture;
	/** premultiplied ink, rim */
	g1: WebGLTexture;
	depth: WebGLRenderbuffer;
	w: number;
	h: number;
}

interface Gpu {
	splat: { prog: WebGLProgram; vao: WebGLVertexArrayObject; buffer: WebGLBuffer; u: Uniforms };
	dots: { prog: WebGLProgram; vao: WebGLVertexArrayObject; u: Uniforms };
	delta: WebGLTexture;
	gbuf: GBuffer | null;
}

const SPLAT_UNIFORMS = [
	"uN", "uActive", "uCenter", "uHalf", "uPivot", "uAnchor", "uRot", "uBreath", "uGRes", "uOrigin", "uTexPerM", "uSplat",
	"uTime", "uForm", "uMouth", "uBlink", "uGaze", "uDrift", "uLoosen", "uDark", "uLight", "uOval", "uJaw", "uFace",
];
const DOT_UNIFORMS = ["uCols", "uGridTL", "uGridSize", "uCell", "uRes", "uAA", "uTime", "uLoosen", "uDark", "uForm"];

function build(gl: WebGL2RenderingContext, head: HeadAsset): Gpu {
	const splatProg = program(gl, SPLAT_VERT, SPLAT_FRAG, ["aPos", "aNrm", "aCol"]);
	const vao = gl.createVertexArray();
	const buffer = gl.createBuffer();
	if (!vao || !buffer) throw new Error("vertex allocation failed");
	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, head.instances, gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 3, gl.SHORT, true, 16, 0);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 4, gl.BYTE, true, 16, 8);
	gl.enableVertexAttribArray(2);
	gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 16, 12);
	const dotVao = gl.createVertexArray();
	if (!dotVao) throw new Error("vertex allocation failed");
	gl.bindVertexArray(null);

	const delta = gl.createTexture();
	if (!delta) throw new Error("createTexture failed");
	gl.bindTexture(gl.TEXTURE_2D, delta);
	const rows = Math.ceil((head.header.shapes.length * head.header.n) / TEX_W);
	const data = new Int8Array(TEX_W * rows * 4);
	data.set(head.deltas);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8_SNORM, TEX_W, rows, 0, gl.RGBA, gl.BYTE, data);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

	const su = uniforms(gl, splatProg, SPLAT_UNIFORMS);
	su.uAct = gl.getUniformLocation(splatProg, "uAct[0]");
	gl.useProgram(splatProg);
	gl.uniform1i(gl.getUniformLocation(splatProg, "uDelta"), 0);
	gl.uniform1i(su.uN, head.header.n);
	gl.uniform3fv(su.uCenter, head.header.center);
	gl.uniform3fv(su.uHalf, head.header.half);
	gl.uniform3fv(su.uPivot, head.header.landmarks.pivot);
	const lm = head.header.landmarks;
	const halfSpan = ((lm.crownY - lm.chinY) / 2) * OVAL_REACH;
	gl.uniform3f(su.uOval, (lm.crownY + lm.chinY) / 2, halfSpan * OVAL_ASPECT, halfSpan);
	gl.uniform3f(su.uJaw, lm.chinY, lm.noseZ - 0.03, lm.pivot[2]);
	gl.uniform2f(su.uFace, lm.eyeY, lm.mouthY);

	const dotProg = program(gl, DOT_VERT, DOT_FRAG);
	gl.useProgram(dotProg);
	gl.uniform1i(gl.getUniformLocation(dotProg, "uG0"), 1);
	gl.uniform1i(gl.getUniformLocation(dotProg, "uG1"), 2);
	return {
		splat: { prog: splatProg, vao, buffer, u: su },
		dots: { prog: dotProg, vao: dotVao, u: uniforms(gl, dotProg, DOT_UNIFORMS) },
		delta,
		gbuf: null,
	};
}

function gTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
	const tex = gl.createTexture();
	if (!tex) throw new Error("G-buffer allocation failed");
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return tex;
}

function makeGBuffer(gl: WebGL2RenderingContext, w: number, h: number): GBuffer {
	const fbo = gl.createFramebuffer();
	const depth = gl.createRenderbuffer();
	if (!fbo || !depth) throw new Error("G-buffer allocation failed");
	const g0 = gTexture(gl, w, h);
	const g1 = gTexture(gl, w, h);
	gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
	gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g0, 0);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g1, 0);
	gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
	// draw buffers are framebuffer state: set once here, never per frame
	gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("G-buffer incomplete");
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	return { fbo, g0, g1, depth, w, h };
}

function freeGBuffer(gl: WebGL2RenderingContext, gpu: Gpu): void {
	const b = gpu.gbuf;
	if (!b) return;
	gl.deleteFramebuffer(b.fbo);
	gl.deleteTexture(b.g0);
	gl.deleteTexture(b.g1);
	gl.deleteRenderbuffer(b.depth);
	gpu.gbuf = null;
}

export function createFaceRenderer(canvas: HTMLCanvasElement, head: HeadAsset, opts: FaceRendererOptions): FaceRenderer {
	const glOrNull = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "high-performance" });
	if (!glOrNull) throw new Error("WebGL2 is not available");
	const gl: WebGL2RenderingContext = glOrNull;
	const { header } = head;
	const lm = header.landmarks;
	const headFraction = opts.headFraction ?? 0.56;
	const anchorFrac = opts.anchor ?? [0.5, 0.43];
	const gain = opts.morphGain ?? 1;
	// typed, so the per-frame `uniform3fv` reads it in place instead of converting a plain array to a sequence each call
	const anchor = Float32Array.of(0, (lm.crownY + lm.chinY) / 2 - 0.015, lm.pivot[2]);
	const rot = new Float32Array(9);
	const act = new Float32Array(POSE_SIZE * 2);
	let gpu: Gpu | null = build(gl, head);
	let dark = opts.dark;
	let quality: FaceQuality = opts.quality ?? "high";
	let cssW = 1, cssH = 1, dpr = 1;
	let grid: HalftoneGrid | null = null;
	let lost = false;

	const onLost = (e: Event) => {
		e.preventDefault();
		lost = true;
		gpu = null;
	};
	const onRestored = () => {
		gpu = build(gl, head);
		lost = false;
	};
	canvas.addEventListener("webglcontextlost", onLost);
	canvas.addEventListener("webglcontextrestored", onRestored);

	function setRot(yaw: number, pitch: number, roll: number) {
		// R = Ry(yaw) * Rx(pitch) * Rz(roll), column-major
		const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
		const m00 = cy, m01 = sy * sx, m02 = sy * cx;
		const m10 = 0, m11 = cx, m12 = -sx;
		const m20 = -sy, m21 = cy * sx, m22 = cy * cx;
		rot[0] = m00 * cz + m01 * sz; rot[3] = -m00 * sz + m01 * cz; rot[6] = m02;
		rot[1] = m10 * cz + m11 * sz; rot[4] = -m10 * sz + m11 * cz; rot[7] = m12;
		rot[2] = m20 * cz + m21 * sz; rot[5] = -m20 * sz + m21 * cz; rot[8] = m22;
	}

	const pxPerM = () => (canvas.height * headFraction) / (lm.crownY - lm.chinY);

	function applySize() {
		// A full-bleed transparent canvas is cleared and composited every frame, so its pixel count is a standing GPU and
		// memory-bandwidth cost: a 2560x1440 window at 2x is 14.7 Mpx. The dots are a halftone with their own pitch, so
		// 1.5x keeps them crisp (the AA width follows the ratio, `uAA`) at 56% of those pixels.
		const cap = quality === "high" ? MAX_RATIO_HIGH : MAX_RATIO_LOW;
		const ratio = Math.min(cap, Math.max(1, dpr));
		const w = Math.max(1, Math.round(cssW * ratio));
		const h = Math.max(1, Math.round(cssH * ratio));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		const ppm = pxPerM();
		// perspective can enlarge the near side by ~10%: the extent allows for it
		grid = halftoneGrid({
			width: w,
			height: h,
			ratio: h / Math.max(1, cssH),
			headPx: h * headFraction,
			origin: [w * anchorFrac[0], h * anchorFrac[1]],
			halfExtent: [DRAW_EXTENT[0] * ppm * 1.12, DRAW_EXTENT[1] * ppm * 1.12],
			low: quality === "low",
		});
		if (gpu?.gbuf && (gpu.gbuf.w !== grid.gw || gpu.gbuf.h !== grid.gh)) freeGBuffer(gl, gpu);
	}

	return {
		resize(w, h, ratio) {
			cssW = w;
			cssH = h;
			dpr = ratio;
			applySize();
		},
		setDark(v) {
			dark = v;
		},
		setQuality(q) {
			if (q === quality) return;
			quality = q;
			applySize();
		},
		draw(f, t) {
			if (lost || !gpu) return;
			if (!grid) applySize();
			const g = gpu;
			const L = grid as HalftoneGrid;
			const W = canvas.width, H = canvas.height;
			if (!g.gbuf) g.gbuf = makeGBuffer(gl, L.gw, L.gh);
			const gb = g.gbuf;

			// the pose -> the shapes that actually move a point, each through the rig table (shapes.ts)
			let active = 0;
			for (let s = 0; s < head.pose.length; s++) {
				const pi = head.pose[s];
				const w = Math.min(f.weights[pi], RIG_MAX[pi]) * RIG_GAIN[pi];
				if (!(w > 0.003)) continue;
				act[active * 2] = s;
				act[active * 2 + 1] = w * header.scales[s] * gain;
				active++;
			}
			setRot(f.yaw, f.pitch, f.roll);
			const ppm = pxPerM();
			const gridW = L.cols * L.cell, gridH = L.rows * L.cell;
			const sx = gb.w / gridW, sy = gb.h / gridH;
			// a key light from the viewer's upper left (the reference's shading), drifting slowly so the halftone breathes
			const lx = -0.45 + 0.1 * Math.sin(t * 0.13), ly = 0.35 + 0.08 * Math.sin(t * 0.09 + 1);
			const time = t % 3600;

			// ---- pass A: the nearest surface into the G-buffer
			const sp = g.splat, su = sp.u;
			gl.bindFramebuffer(gl.FRAMEBUFFER, gb.fbo);
			gl.viewport(0, 0, gb.w, gb.h);
			gl.clearColor(0, 0, 0, 0);
			gl.clearDepth(1);
			gl.enable(gl.DEPTH_TEST);
			gl.depthFunc(gl.LESS);
			gl.depthMask(true);
			gl.disable(gl.BLEND);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
			gl.useProgram(sp.prog);
			gl.bindVertexArray(sp.vao);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, g.delta);
			gl.uniform2fv(su.uAct, act);
			gl.uniform1i(su.uActive, active);
			gl.uniform3fv(su.uAnchor, anchor);
			gl.uniformMatrix3fv(su.uRot, false, rot);
			gl.uniform1f(su.uBreath, f.breath);
			gl.uniform2f(su.uGRes, gb.w, gb.h);
			gl.uniform2f(su.uOrigin, (W * anchorFrac[0] - L.x0) * sx, (H * anchorFrac[1] - L.y0) * sy);
			gl.uniform2f(su.uTexPerM, ppm * sx, ppm * sy);
			gl.uniform1f(su.uSplat, Math.max(0.75, SPLAT * header.rowSpacing * ppm * Math.min(sx, sy)));
			gl.uniform1f(su.uTime, time);
			gl.uniform1f(su.uForm, f.formation);
			gl.uniform1f(su.uMouth, f.mouthOpen);
			gl.uniform1f(su.uBlink, Math.max(f.weights[BLINK_L], f.weights[BLINK_R]));
			gl.uniform2f(su.uGaze, f.gazeX, f.gazeY);
			gl.uniform3f(su.uDrift, f.warm, f.hue, 0.5 + 0.5 * Math.sin(t * 0.07));
			gl.uniform1f(su.uLoosen, f.loosen);
			gl.uniform3f(su.uLight, lx, ly, 0.85);
			gl.uniform1f(su.uDark, dark ? 1 : 0);
			gl.drawArrays(gl.POINTS, 0, header.n);

			// ---- pass B: one dot per grid cell onto the canvas
			const dp = g.dots, du = dp.u;
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, W, H);
			gl.disable(gl.DEPTH_TEST);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			gl.useProgram(dp.prog);
			gl.bindVertexArray(dp.vao);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, gb.g0);
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, gb.g1);
			gl.activeTexture(gl.TEXTURE0);
			gl.uniform1i(du.uCols, L.cols);
			gl.uniform2f(du.uGridTL, L.x0, L.y0);
			gl.uniform2f(du.uGridSize, gridW, gridH);
			gl.uniform1f(du.uCell, L.cell);
			gl.uniform2f(du.uRes, W, H);
			gl.uniform1f(du.uAA, Math.max(0.9, (H / cssH) * 0.8));
			gl.uniform1f(du.uTime, time);
			gl.uniform1f(du.uLoosen, f.loosen);
			gl.uniform1f(du.uDark, dark ? 1 : 0);
			gl.uniform1f(du.uForm, f.formation);
			gl.drawArrays(gl.POINTS, 0, L.cols * L.rows);
			gl.bindVertexArray(null);
		},
		dispose() {
			canvas.removeEventListener("webglcontextlost", onLost);
			canvas.removeEventListener("webglcontextrestored", onRestored);
			if (gpu) {
				freeGBuffer(gl, gpu);
				gl.deleteProgram(gpu.splat.prog);
				gl.deleteProgram(gpu.dots.prog);
				gl.deleteVertexArray(gpu.splat.vao);
				gl.deleteVertexArray(gpu.dots.vao);
				gl.deleteBuffer(gpu.splat.buffer);
				gl.deleteTexture(gpu.delta);
			}
			gpu = null;
		},
	};
}
