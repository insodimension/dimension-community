// The two GPU passes of the halftone face (see renderer.ts for how they are driven).
//
// SPLAT (pass A): every baked head dot is posed exactly as before (ARKit morph deltas from a texture, head
// rotation, breathing, gaze, the orb -> face formation) and splatted as a small disc WITH depth test into a
// two-target G-buffer, so only the nearest surface survives; the disc radius closes the gaps between the baked
// rows. G0 = premultiplied colour + presence, G1 = premultiplied (ink, rim).
//
// DOTS (pass B): one point per cell of the screen grid; its vertex shader reads the G-buffer at the cell centre
// (bilinear) and turns it into a dot: radius from ink, colour from the skin, alpha from presence; cells near
// the silhouette thin out and scatter outward along the coverage gradient.
import { POSE_SIZE } from "./shapes";

/** Width of the morph-delta texture; the splat shader addresses it with `& (TEX_W - 1)` and `>> 11`. */
export const TEX_W = 2048;

const HASH = `
uint hash(uint x) {
	x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
	return x;
}
float h01(uint x) { return float(hash(x) & 0xffffffu) / 16777216.0; }`;

export const SPLAT_VERT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define ACT ${POSE_SIZE}

in vec3 aPos;
in vec4 aNrm;
in vec4 aCol;

uniform sampler2D uDelta;
uniform vec2 uAct[ACT];
uniform int uActive;
uniform int uN;
uniform vec3 uCenter;
uniform vec3 uHalf;
uniform vec3 uPivot;
uniform vec3 uAnchor;
uniform mat3 uRot;
uniform float uBreath;
uniform vec2 uGRes;
uniform vec2 uOrigin;
uniform vec2 uTexPerM;
uniform float uSplat;
uniform float uTime;
uniform float uForm;
uniform float uMouth;
uniform float uBlink;
uniform vec2 uGaze;
uniform vec3 uDrift;
uniform float uLoosen;
uniform float uDark;
uniform vec3 uLight;
/** Head oval in model space: centre y, half width, half height (metres). */
uniform vec3 uOval;
/** The jaw line in model space: chin y, the chin's depth z, the ears' depth z (metres). */
uniform vec3 uJaw;
/** The eye line and the mouth line in model space, y (metres): the brows arch over one, the lips sit on the other. */
uniform vec2 uFace;

out vec4 vCol;
out vec3 vTone;
${HASH}
vec3 hueRot(vec3 c, float a) {
	const vec3 k = vec3(0.57735027);
	float ca = cos(a), sa = sin(a);
	return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec4(0.0); vTone = vec3(0.0); }

void main() {
	int id = gl_VertexID;
	vec3 n = uRot * normalize(aNrm.xyz);
	float facing = n.z;
	// the far side of the head never reaches the paper; the depth test would hide it, this saves its fill. The
	// mouth's inside faces every way, so it is exempt (the lips occlude it until they part).
	bool inside = aCol.a > 0.75;
	if (uForm >= 1.0 && facing < -0.35 && !inside) { cull(); return; }

	vec3 p = uCenter + aPos * uHalf;
	// the reference is a head with no neck: outside an oval around the crown-to-chin span, and below the jaw line
	// (level with the chin at the front, rising ~5 cm toward the ears), the surface dissolves
	float oval = smoothstep(1.06, 0.84, length(vec2(p.x / uOval.y, (p.y - uOval.x) / uOval.z)));
	float jawY = uJaw.x + 0.05 * clamp((uJaw.y - p.z) / max(uJaw.y - uJaw.z, 1e-3), 0.0, 1.0);
	oval *= smoothstep(jawY - 0.03, jawY + 0.004, p.y);
	// the brows, placed on the rest pose (so the brow morphs carry them): an arch ~2.4 cm over the eye line. The bake
	// flattens their albedo toward the skin, which paper forgives and a lit surface does not, so dark mode draws
	// them from here.
	float bx = abs(p.x);
	float bt = clamp((bx - 0.034) / 0.024, -1.0, 1.0);
	float arch = 0.024 + 0.005 * (1.0 - bt * bt);
	float brow = smoothstep(0.009, 0.014, bx) * smoothstep(0.058, 0.048, bx) * smoothstep(0.0038, 0.0018, abs(p.y - uFace.x - arch)) * step(0.4, aNrm.z);
	// the lips the same way: a soft ellipse on the mouth line, for the coral that must read even with the mouth shut
	float lip = smoothstep(1.0, 0.7, length(vec2(p.x / 0.027, (p.y - uFace.y) / 0.011))) * step(0.3, aNrm.z);
	for (int k = 0; k < ACT; k++) {
		if (k >= uActive) break;
		int t = int(uAct[k].x) * uN + id;
		p += texelFetch(uDelta, ivec2(t & ${TEX_W - 1}, t >> 11), 0).rgb * uAct[k].y;
	}
	p = uRot * (p - uPivot) + uPivot;
	p.y += uBreath;

	float fade = aNrm.w;
	float vis = fade * fade * oval;
	if (inside) vis *= smoothstep(0.05, 0.38, uMouth); // mouth interior only exists once the lips part
	else if (aCol.a > 0.25) {
		vis *= (1.0 - smoothstep(0.25, 0.7, uBlink)) * 0.9; // eyeballs hide behind closing lids
		p.xy += uGaze * 0.0035;
	}

	// ---- tone. LIGHT (ink on paper), the way the reference reads: a side key light; the lit side is a fine grain
	// of tiny grey dots, the dots swell and turn rose into the shade, shadow creases (nose side, sockets, under the
	// brow) run red, features (brows, eyes, lips) carry the heaviest ink; the silhouette then thins to nothing.
	// DARK (light on near-black): the same light read the other way round. ink is how much light a dot gives:
	// the lit planes swell into warm peach/amber dots, the turn into shade dims to rose and coral, and brows,
	// eyes, nostrils and creases give almost none, so the features read as holes in a luminous surface.
	vec3 L = normalize(uLight);
	float ndl = max(dot(n, L), 0.0);
	float lit = 0.1 + 0.9 * ndl;
	float lum = dot(aCol.rgb, vec3(0.30, 0.59, 0.11));
	float feature = smoothstep(0.62, 0.3, lum);
	float side = 1.0 - smoothstep(0.2, 0.9, facing);
	float shade = 1.0 - lit;
	float crease = smoothstep(0.45, 0.85, shade) * 4.0 * side * (1.0 - side);
	float coral = smoothstep(0.10, 0.28, aCol.r - aCol.g);
	float eye = step(0.25, aCol.a) * (1.0 - step(0.75, aCol.a));
	float rim = smoothstep(0.08, 0.85, facing - uLoosen * 0.12);
	vec3 c = aCol.rgb;
	float ink;
	if (uDark < 0.5) {
		ink = clamp(0.1 + 0.75 * shade + 0.2 * side + 0.65 * feature + 0.25 * coral, 0.0, 1.0);
		float grey = mix(lum, 0.5, 0.35) * 0.92;
		vec3 skin = mix(vec3(grey) * vec3(1.0, 0.96, 0.96), vec3(0.8, 0.61, 0.65), clamp(smoothstep(0.12, 0.6, shade) * 0.85 + side * 0.4, 0.0, 1.0));
		// the lit front drifts toward olive/amber with the slow colour drift, as the reference's does
		skin = mix(skin, mix(vec3(0.5, 0.53, 0.32), vec3(0.74, 0.57, 0.34), uDrift.z), (1.0 - side) * (1.0 - smoothstep(0.1, 0.5, shade)) * 0.42);
		skin = mix(skin, vec3(0.72, 0.26, 0.28), clamp(crease * 0.65, 0.0, 1.0));
		// brows, lashes, pupils: dark ink so the eyes always read
		skin = mix(skin, vec3(0.26, 0.23, 0.24), feature * 0.55);
		vec3 accent = mix(mix(vec3(lum), c, 0.8), vec3(0.88, 0.3, 0.32), 0.55);
		c = mix(skin, accent, coral);
	} else {
		// the same key light, raked further round so the planes model (a frontal light would glow the whole face
		// evenly); a soft fill keeps the shaded cheek glowing faintly instead of dropping to black. The side of the
		// head that turns away from the viewer dims whatever the light does, so the face leads.
		float key = max(dot(n, normalize(vec3(uLight.x * 1.3, uLight.y * 1.2, 0.62))), 0.0);
		// ...and so does the side of the head in its own frame (temples, ears), so a turned head still leads with the face
		float glow = (0.48 + 0.52 * key) * mix(0.45, 1.0, smoothstep(0.1, 0.75, facing)) * mix(0.55, 1.0, smoothstep(0.05, 0.6, normalize(aNrm.xyz).z));
		// the bake flattens brow and lash contrast toward the skin mean; on dark the features need it back, so the
		// mask starts earlier and runs steeper than on paper
		feature = max(smoothstep(0.6, 0.42, lum), brow * 0.8);
		ink = glow * (1.0 - 0.92 * feature) * (1.0 - 0.6 * crease) * mix(1.0, 0.55, eye);
		// colour runs with the light: cream peach where it is lit (drifting olive / amber), rose peach through the
		// turn, rose into the shade; the cheeks (the face's sides) lean rose
		float dim = 1.0 - glow;
		vec3 skin = mix(vec3(1.0, 0.86, 0.72), vec3(1.0, 0.62, 0.6), smoothstep(0.12, 0.38, dim));
		skin = mix(skin, vec3(0.96, 0.42, 0.56), smoothstep(0.32, 0.62, dim));
		skin = mix(skin, mix(vec3(0.82, 0.86, 0.52), vec3(1.0, 0.74, 0.44), uDrift.z), (1.0 - side) * (1.0 - smoothstep(0.1, 0.35, dim)) * 0.32);
		skin = mix(skin, vec3(1.0, 0.5, 0.56), side * (1.0 - side) * 2.0 * (1.0 - feature));
		skin = mix(skin, vec3(0.9, 0.26, 0.34), clamp(crease * 0.8, 0.0, 1.0));
		skin = mix(skin, vec3(0.6, 0.4, 0.42), feature * 0.7);
		// lips: coral light of their own, brighter than the skin they sit in
		float lips = max(coral, lip * 0.85);
		c = mix(skin, vec3(1.0, 0.38, 0.36), lips);
		ink = mix(ink, 0.6 + 0.35 * glow, lips);
	}
	// the open mouth is the deepest tone on the face, a dark wine red: the one shape speech has to read by. Its
	// surfaces face every way, so it never reads as a turning-away rim.
	if (inside) {
		c = mix(c, vec3(0.36, 0.14, 0.16), 0.75);
		ink = uDark < 0.5 ? max(ink, 0.9) : min(ink, 0.08);
		rim = 1.0;
	}
	c = hueRot(c, uDrift.y);
	c *= vec3(1.0 + 0.05 * uDrift.x, 1.0, 1.0 - 0.06 * uDrift.x);

	float grow = 1.0;
	// ---- formation: an orb of loose gradient points that gathers into the head
	if (uForm < 1.0) {
		uint hb = uint(id) * 4u;
		float h1 = h01(hb + 1u), h2 = h01(hb + 2u), h3 = h01(hb + 3u), h4 = h01(hb + 4u);
		float local = clamp((uForm - h1 * 0.3) / 0.7, 0.0, 1.0);
		float e = local * local * (3.0 - 2.0 * local);
		float th = h2 * 6.2832 + uTime * 0.5, ph = acos(2.0 * h3 - 1.0);
		vec3 dir = vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th));
		vec3 orb = uAnchor + dir * (0.155 * pow(h4, 0.4));
		vec3 swirl = cross(dir, vec3(0.3, 1.0, 0.2)) * sin(e * 3.1416) * 0.09;
		p = mix(orb + swirl, p, e);
		float g = smoothstep(-0.7, 0.7, dot(dir, normalize(vec3(0.75, -0.5, 0.4))) + (h1 - 0.5) * 0.5);
		vec3 orbCol = mix(mix(vec3(0.94, 0.47, 0.30), vec3(0.98, 0.72, 0.52), h2), vec3(0.24, 0.50, 0.36), g);
		orbCol = mix(orbCol, pow(orbCol, vec3(0.6)), uDark);
		float ec = smoothstep(0.35, 1.0, e);
		c = mix(orbCol, c, ec);
		ink = mix(0.55 + 0.3 * h2, ink, ec);
		rim = mix(smoothstep(-0.4, 0.6, dir.z), rim, ec);
		vis = mix(1.0, vis, ec);
		grow = mix(2.2, 1.0, ec);
	}
	if (vis < 0.02) { cull(); return; }

	vec3 q = p - uAnchor;
	float pers = 1.0 / (1.0 - q.z * 0.8);
	vec2 t = uOrigin + vec2(q.x, -q.y) * uTexPerM * pers;
	gl_Position = vec4(t.x / uGRes.x * 2.0 - 1.0, 1.0 - t.y / uGRes.y * 2.0, clamp(-q.z * 2.5, -1.0, 1.0), 1.0);
	// lips splat tighter: a splat is wider than the gap it borders, and the full size would paper over a small
	// opening of the mouth (0.68 of the row spacing still closes the lattice)
	gl_PointSize = max(1.0, 2.0 * uSplat * pers * grow * mix(1.0, 0.62, coral));
	vCol = vec4(clamp(c, 0.0, 1.0), vis);
	// depth toward the viewer, 1 cm = 0.025: pass B reads it back for the creases (cavities) the key light misses
	vTone = vec3(ink, rim, clamp(0.5 + q.z * 2.5, 0.0, 1.0));
}`;

export const SPLAT_FRAG = `#version 300 es
precision mediump float;
in vec4 vCol;
in vec3 vTone;
layout(location = 0) out vec4 g0;
layout(location = 1) out vec4 g1;
void main() {
	vec2 d = gl_PointCoord * 2.0 - 1.0;
	if (dot(d, d) > 1.2) discard;
	g0 = vec4(vCol.rgb * vCol.a, vCol.a);
	g1 = vec4(vTone * vCol.a, vCol.a);
}`;

export const DOT_VERT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform int uCols;
uniform vec2 uGridTL;
uniform vec2 uGridSize;
uniform float uCell;
uniform vec2 uRes;
uniform float uAA;
uniform float uTime;
uniform float uLoosen;
uniform float uDark;
uniform float uForm;

out vec4 vCol;
flat out vec3 vDot;
${HASH}
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec4(0.0); vDot = vec3(1.0); }
vec2 uvOf(vec2 px) { return vec2((px.x - uGridTL.x) / uGridSize.x, 1.0 - (px.y - uGridTL.y) / uGridSize.y); }

void main() {
	int row = gl_VertexID / uCols;
	int col = gl_VertexID - row * uCols;
	uint hb = hash(uint(col) * 0x9E3779B1u ^ hash(uint(row) + 0x632BE5ABu)) * 8u;
	float h1 = h01(hb + 1u), h2 = h01(hb + 2u), h3 = h01(hb + 3u), h4 = h01(hb + 4u), h5 = h01(hb + 5u);

	vec2 c = uGridTL + (vec2(col, row) + 0.5) * uCell + (vec2(h1, h2) - 0.5) * uCell * 0.2;
	vec4 a = texture(uG0, uvOf(c));
	if (a.a < 0.03) { cull(); return; }
	vec4 b = texture(uG1, uvOf(c));
	float s = a.a;
	// neighbouring dots are not one flat tint: each leans a little rose or a little grey (on dark, a little rose or
	// a little peach, so the light keeps its colour), as the reference's do
	vec3 colour = a.rgb / s;
	vec3 lean = mix(vec3(dot(colour, vec3(0.3, 0.59, 0.11))), colour * vec3(1.04, 0.94, 0.86), uDark);
	colour = mix(colour, mix(lean, mix(vec3(0.86, 0.6, 0.63), vec3(1.0, 0.56, 0.58), uDark), h01(hb + 6u)), mix(0.32, 0.22, uDark));
	float ink = clamp(b.r / s, 0.0, 1.0);
	// ---- creases: a cell sitting a little deeper than its neighbours (sockets, the nose's flank, the lip line,
	// the nasolabial fold) takes more ink and runs red; a ridge (bridge, brow) lightens. A jump of more than ~1.6 cm
	// is one surface occluding another (jaw over neck, cheek over ear), not a crease: that neighbour is ignored.
	// The loose orb has no surface to crease, so the term waits for the face to form.
	float cav = 0.0;
	if (uForm > 0.6) {
		float d0 = b.b / s;
		float kc = uCell * 2.0;
		float dsum = 0.0, wsum = 0.0;
		for (int i = 0; i < 4; i++) {
			vec2 o = i == 0 ? vec2(kc, 0.0) : i == 1 ? vec2(-kc, 0.0) : i == 2 ? vec2(0.0, kc) : vec2(0.0, -kc);
			vec4 nb = texture(uG1, uvOf(c + o));
			float dd = nb.b / max(nb.a, 1e-3) - d0;
			float w = step(0.3, nb.a) * step(abs(dd), 0.04);
			dsum += w * dd;
			wsum += w;
		}
		cav = wsum > 0.0 ? clamp(dsum / wsum / 0.012, -1.0, 1.0) * smoothstep(0.6, 1.0, uForm) : 0.0;
	}
	// on paper a crease is more (red) ink; on dark it is less light: the dot shrinks and dims to a deep red
	float crease = max(cav, 0.0);
	ink = uDark < 0.5
		? clamp(ink + 0.45 * crease - 0.15 * max(-cav, 0.0), 0.0, 1.0)
		: clamp(ink * (1.0 - 0.75 * crease) + 0.1 * max(-cav, 0.0), 0.0, 1.0);
	colour = mix(colour, mix(vec3(0.7, 0.25, 0.27), vec3(0.78, 0.22, 0.27), uDark), crease * 0.5);
	// edge: 1 on the solid front of the face, falling to 0 where the surface turns away or the coverage ends
	float cover = smoothstep(0.03, 0.75, s);
	float edge = clamp(b.g / s + (h3 - 0.5) * 0.3, 0.0, 1.0) * cover;

	// ---- dissolve: toward the silhouette dots thin out and drift outward (further when thinking)
	float keep = mix(0.18, 1.0, smoothstep(0.0, 0.75, edge)) - 0.15 * uLoosen * (1.0 - edge);
	if (h4 > keep) { cull(); return; }
	vec2 off = vec2(0.0);
	float scat = pow(1.0 - edge, 1.5);
	if (edge < 0.97) {
		float k = uCell * 1.5;
		vec2 grad = vec2(texture(uG0, uvOf(c + vec2(k, 0.0))).a - texture(uG0, uvOf(c - vec2(k, 0.0))).a,
			texture(uG0, uvOf(c + vec2(0.0, k))).a - texture(uG0, uvOf(c - vec2(0.0, k))).a);
		vec2 dirOut = dot(grad, grad) > 1e-4 ? -normalize(grad) : normalize(vec2(h1, h2) - 0.5 + 1e-3);
		off = dirOut * scat * uCell * (0.3 + 1.8 * h3 * h3 + 2.5 * uLoosen * h3) + (vec2(h4, h1) - 0.5) * scat * uCell * 0.8;
		float stray = step(0.985, h5);
		off += dirOut * stray * uCell * (2.5 + 7.0 * h1) * (0.65 + 0.35 * sin(uTime * 0.35 + h2 * 20.0));
	}

	float r = uCell * mix(mix(0.14, 0.04, uDark), mix(0.46, 0.44, uDark), pow(ink, mix(0.9, 1.35, uDark))) * mix(0.55, 1.0, edge) * (0.8 + 0.4 * h2);
	float alpha = mix(mix(0.8, 0.95, pow(ink, 0.7)), mix(0.4, 1.0, pow(ink, 0.8)), uDark) * mix(0.18, 1.0, edge) * mix(0.6, 1.0, cover);
	float feather = uAA * mix(1.0, 3.0, 1.0 - edge);

	vec2 px = c + off;
	float half_ = r + feather + 1.0;
	gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
	gl_PointSize = 2.0 * half_;
	vCol = vec4(colour, alpha);
	vDot = vec3(r, feather, half_);
}`;

export const DOT_FRAG = `#version 300 es
precision mediump float;
in vec4 vCol;
flat in vec3 vDot;
out vec4 outColor;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * vDot.z;
	float cover = clamp((vDot.x - length(p)) / vDot.y + 0.5, 0.0, 1.0);
	float a = vCol.a * cover * cover * (3.0 - 2.0 * cover);
	outColor = vec4(vCol.rgb * a, a);
}`;
