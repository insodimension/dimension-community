// Cross-pack guard for the "asks in every mode" gate: a representative publish,
// send or irreversible-delete tool from each connector pack that keeps that gate
// must resolve to a prompt in yolo mode, and the low-stakes writes that were
// deliberately left ungated must keep auto-approving there. One or two tools per
// pack, not an inventory — each pack's own tests own its full surface. Slack is
// not in the first list on purpose: its sends are tier exec (ask in Ask and Write
// mode, run in Full access) so an unattended autonomy never waits on a card, and
// the Slack pack's own tests pin all three modes.
//
// Every pack is loaded through its default-exported factory and decided by the
// engine's own `resolveApproval` (the packs' `@oh-my-pi/pi-coding-agent` peer).
// google-drive registers its write tools only when the stored credential grants
// a write scope, so it is loaded with HOME pointed at a temp dir holding a
// write-scoped credential: `CONFIG_TARGET` is derived from `homedir()` at module
// load, so HOME is swapped around the dynamic import only and restored at once.

import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import discord from "../../discord/index";
import googleCalendar from "../../google-calendar/index";
import googleMeet from "../../google-meet/index";
import reddit from "../../reddit/index";
import slack from "../../slack/index";
import teams from "../../teams/index";
import telegram from "../../telegram/index";
import whatsapp from "../../whatsapp/index";
import youtube from "../../youtube/index";
import x from "../index";

type ApprovalSubject = Parameters<typeof resolveApproval>[0];

const home = await mkdtemp(join(tmpdir(), "dimension-gated-tools-"));
await mkdir(join(home, ".config", "dimension-google-drive"), { recursive: true });
await writeFile(
	join(home, ".config", "dimension-google-drive", "token.json"),
	JSON.stringify({
		access: "a",
		refresh: "r",
		expires: 0,
		clientId: "c",
		scopes: ["https://www.googleapis.com/auth/drive"],
	}),
);
const priorHome = process.env.HOME;
const priorUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
// Dynamic on purpose: a static import is hoisted above the HOME override.
const { default: googleDrive } = await import("../../google-drive/index");
if (priorHome === undefined) delete process.env.HOME;
else process.env.HOME = priorHome;
if (priorUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = priorUserProfile;

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

const tools = new Map<string, ApprovalSubject>();
const collector = {
	registerTool(tool: ApprovalSubject) {
		tools.set(tool.name, tool);
	},
	on() {},
} as unknown as Parameters<typeof x>[0];
for (const factory of [x, discord, slack, teams, telegram, whatsapp, reddit, youtube, googleCalendar, googleMeet]) {
	factory(collector);
}
await googleDrive(collector);

function yolo(name: string) {
	const tool = tools.get(name);
	if (!tool) throw new Error(`no pack registered ${name}`);
	return resolveApproval(tool, {}, "yolo").policy;
}

test.each([
	"x_post",
	"x_delete",
	"discord_send_message",
	"discord_delete_message",
	"teams_send_channel_message",
	"telegram_send_message",
	"telegram_delete_message",
	"whatsapp_send_message",
	"discord_timeout_member",
	"discord_publish_message",
	"youtube_post_comment",
	"youtube_update_video",
	"google_drive_share_file",
	"google_calendar_delete_event",
	"google_meet_end_active_conference",
])("%s prompts even in yolo mode", name => {
	expect(yolo(name)).toBe("prompt");
});

test.each(["x_bookmark", "discord_add_reaction", "discord_set_thread_tags"])("%s stays auto-approved in yolo mode", name => {
	expect(yolo(name)).toBe("allow");
});
