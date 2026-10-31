import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../plugin.json";

async function importExtensionUnderHome(pinned: string) {
	const priorHome = process.env.HOME;
	const priorUserProfile = process.env.USERPROFILE;
	process.env.HOME = pinned;
	process.env.USERPROFILE = pinned;
	try {
		return (await import("../index")).default;
	} finally {
		if (priorHome === undefined) delete process.env.HOME;
		else process.env.HOME = priorHome;
		if (priorUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = priorUserProfile;
	}
}

const home = await mkdtemp(join(tmpdir(), "dimension-google-meet-sessions-"));
const meetingsDir = join(home, ".config", "dimension-google-meet", "meetings");
const outDir = join(meetingsDir, "abc-defg-hij");
await mkdir(outDir, { recursive: true });
const googleMeetExtension = await importExtensionUnderHome(home);

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

interface RegisteredTool {
	name: string;
	execute?: (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }>;
}

type Session = Map<string, RegisteredTool>;

function loadSession(): Session {
	const session: Session = new Map();
	googleMeetExtension({
		registerTool(tool: RegisteredTool) {
			session.set(tool.name, tool);
		},
	} as unknown as Parameters<typeof googleMeetExtension>[0]);
	return session;
}

async function run(session: Session, name: string, params: unknown = {}): Promise<string> {
	const tool = session.get(name);
	if (!tool?.execute) throw new Error(`google-meet did not register ${name}`);
	const result = await tool.execute("call", params);
	return result.content.map(part => part.text).join("\n");
}

test("every session registers its own tool objects, one per tool the manifest declares", () => {
	const declared = manifest.extensions["ai.insodimension.dimension"].tools.map(entry => entry.name);
	const first = loadSession();
	const second = loadSession();

	expect([...first.keys()].sort()).toEqual([...declared].sort());
	expect([...second.keys()]).toEqual([...first.keys()]);
	for (const [name, registered] of first) expect(second.get(name)).not.toBe(registered);
});

test("sessions read the active meeting live from the machine-wide pointer, so one session's leave ends it for the other", async () => {
	const first = loadSession();
	const second = loadSession();
	expect(await run(first, "google_meet_live_status")).toBe("No active meeting.");

	await writeFile(
		join(meetingsDir, ".active.json"),
		JSON.stringify({
			pid: 0,
			meetingId: "abc-defg-hij",
			outDir,
			url: "https://meet.google.com/abc-defg-hij",
			startedAt: Date.now(),
			logPath: join(outDir, "bot.log"),
		}),
	);
	await writeFile(join(outDir, "transcript.txt"), "[10:00:00] Ada: hello\n[10:00:05] Bo: hi\n");

	for (const session of [first, second]) {
		expect(await run(session, "google_meet_live_status")).toContain("Meeting: abc-defg-hij");
		expect(await run(session, "google_meet_live_transcript", { last: 1 })).toContain("[10:00:05] Bo: hi");
	}

	expect(await run(second, "google_meet_leave")).toContain("Left abc-defg-hij");
	expect(await run(first, "google_meet_live_status")).toBe("No active meeting.");
	expect(await run(second, "google_meet_live_transcript")).toBe("No active meeting.");
});
