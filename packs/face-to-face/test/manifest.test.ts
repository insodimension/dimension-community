// What a host does with this pack's manifest and with the Chat space's: every component the manifest declares must be
// an export of the committed bundle (the host resolves a fill by that export, and a name the bundle lacks is a surface
// that never mounts), and the Chat space must reach the Face from its rail and name no pinned widget of this pack.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PACK = resolve(import.meta.dir, "..");
const NAMESPACE = "ai.insodimension.dimension";

interface Component {
	readonly id: string;
	readonly slot: string;
	readonly export?: string;
}

interface RailAction {
	readonly id: string;
	readonly label: string;
	readonly target: string;
	readonly surface?: string;
}

interface Space {
	readonly id: string;
	readonly components: Readonly<Record<string, string>>;
	readonly widgets?: { readonly pinned?: readonly { readonly fill: string }[] };
	readonly rail: { readonly actions: readonly RailAction[] };
	readonly workspace: { readonly surfaces: readonly string[] };
}

interface Manifest {
	readonly extensions: Readonly<Record<string, { readonly components?: readonly Component[]; readonly spaces?: readonly Space[] }>>;
}

const manifestAt = (path: string): Manifest => JSON.parse(readFileSync(path, "utf8"));

const faceComponents = manifestAt(join(PACK, "plugin.json")).extensions[NAMESPACE]?.components ?? [];
const chat = (manifestAt(resolve(PACK, "../chat/plugin.json")).extensions[NAMESPACE]?.spaces ?? []).find((space) => space.id === "chat");

function bundleExports(): string[] {
	const bundle = readFileSync(join(PACK, "dist/index.mjs"), "utf8");
	const names = /^export\s*\{([^}]*)\}/m.exec(bundle)?.[1] ?? "";
	return names
		.split(",")
		.map((part) => part.trim().split(/\s+as\s+/))
		.filter((parts) => parts[0] !== "")
		.map((parts) => parts[parts.length - 1] as string);
}

describe("the Face's manifest against its bundle", () => {
	test("the parse is not vacuous: the pack declares a component and the bundle exports its default", () => {
		expect(faceComponents.length).toBeGreaterThan(0);
		expect(bundleExports()).toContain("default");
	});

	test("every declared component is an export of the committed bundle", () => {
		const exported = bundleExports();
		const missing = faceComponents.filter((component) => !exported.includes(component.export ?? "default")).map((component) => component.id);
		expect(missing).toEqual([]);
	});
});

describe("the Chat space reaches the Face", () => {
	test("the space is found and its face surface is filled by a component this pack declares", () => {
		expect(chat).toBeDefined();
		expect(chat?.workspace.surfaces).toContain("face");
		expect(faceComponents.map((component) => component.id)).toContain(chat?.components.face ?? "");
	});

	test("a rail row opens the face surface, and it is the way in: no pinned widget is filled by this pack", () => {
		const rows = (chat?.rail.actions ?? []).filter((action) => action.target === "surface" && action.surface === "face");
		expect(rows).toHaveLength(1);

		const pinnedFills = (chat?.widgets?.pinned ?? []).map((pin) => pin.fill);
		expect(pinnedFills.filter((fill) => faceComponents.some((component) => component.id === fill))).toEqual([]);
	});
});
