import type { PluginCliMain } from "@oh-my-pi/pi-coding-agent/capability/plugin-cli";
import { runGate } from "./gate/run";
import { runImport } from "./import";
import { runNewFilm, runSetup } from "./scaffold";

const USAGE = [
	"usage: inso dd gate <script|cut> <production> <report>",
	"       inso dd setup <brand folder | productions folder>",
	"       inso dd new-film <production folder> [<film>/<rev>]",
	"       inso dd import <earlier kit folder> <brand folder | productions folder>",
	"       inso dd root",
].join("\n");

const main: PluginCliMain = async (argv, { pluginRoot, cwd }) => {
	const [command, ...rest] = argv;
	if (command === "gate") return runGate(rest, pluginRoot);
	if (command === "setup") return runSetup(rest, cwd);
	if (command === "new-film") return runNewFilm(rest, pluginRoot, cwd);
	if (command === "import") return runImport(rest, cwd);
	if (command === "root") {
		process.stdout.write(`${pluginRoot}\n`);
		return 0;
	}
	process.stderr.write(`${USAGE}\n`);
	return 2;
};

export default main;
