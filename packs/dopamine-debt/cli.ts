import type { PluginCliMain } from "@oh-my-pi/pi-coding-agent/capability/plugin-cli";
import { runNewFilm, runSetup } from "./scaffold";

const USAGE = [
	"usage: dd gate <script|cut> <production> <report>",
	"       dd setup <brand folder | productions folder>",
	"       dd new-film <production folder> [<film>/<rev>]",
].join("\n");

const main: PluginCliMain = async (argv, { pluginRoot, cwd }) => {
	const [command, ...rest] = argv;
	if (command === "gate") return (await import("./gate/run")).runGate(rest, pluginRoot);
	if (command === "setup") return runSetup(rest, pluginRoot, cwd);
	if (command === "new-film") return runNewFilm(rest, pluginRoot, cwd);
	process.stderr.write(`${USAGE}\n`);
	return 2;
};

export default main;

if (import.meta.main) {
	const argv = process.argv.slice(2);
	process.exit(await main(argv[0] === "dd" ? argv.slice(1) : argv, { pluginRoot: import.meta.dir, cwd: process.cwd() }));
}
