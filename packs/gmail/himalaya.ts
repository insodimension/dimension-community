import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accountFlag } from "./account";
import { buildTemplate, type Email, isAddress } from "./message";

const LOOKUP_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 120_000;

export interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export interface RunOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
}

export type RunHimalaya = (args: readonly string[], stdin: string, options: RunOptions) => Promise<ProcessResult>;

export type Interruption = "timeout" | "aborted";

export class ProcessInterrupted extends Error {
	constructor(readonly reason: Interruption) {
		super(`the process was stopped (${reason})`);
	}
}

export function runProcess(
	command: string,
	args: readonly string[],
	stdin: string,
	options: RunOptions,
): Promise<ProcessResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ProcessResult>();
	const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let stdout = "";
	let stderr = "";
	let interruption: Interruption | null = null;
	const stop = (reason: Interruption) => {
		interruption ??= reason;
		child.kill();
	};
	const onAbort = () => stop("aborted");
	const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
	const settle = () => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	child.stdout.setEncoding("utf8").on("data", chunk => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", chunk => {
		stderr += chunk;
	});
	child.on("error", error => {
		settle();
		reject(error);
	});
	child.on("close", code => {
		settle();
		if (interruption !== null) reject(new ProcessInterrupted(interruption));
		else resolve({ exitCode: code ?? 1, stdout, stderr });
	});
	child.stdin.on("error", () => {});
	child.stdin.end(stdin);
	return promise;
}

export const runHimalaya: RunHimalaya = (args, stdin, options) => runProcess("himalaya", args, stdin, options);

const SEND_NOT_INSTALLED =
	"himalaya is not installed, or is not on your PATH, so nothing was sent. Open Plugins → Gmail to install it and connect your mailbox.";
const CAUSE_LINES = /^(?:Note|Location|Backtrace|Suggestion):|^Error:?$/;

function reasonFrom(result: ProcessResult): string {
	const lines = result.stderr
		.split(/\r?\n/)
		.map(line => line.trim().replace(/^\d+:\s*/, ""))
		.filter(line => line.length > 0 && !CAUSE_LINES.test(line));
	return lines.length > 0 ? lines.join(": ").slice(0, 400) : `himalaya exited with code ${result.exitCode}`;
}

export interface Invocation {
	readonly args: readonly string[];
	readonly stdin: string;
	readonly options: RunOptions;
	readonly onFailure: (why: string) => string;
	readonly onMissing: string;
}

export async function runChecked(run: RunHimalaya, invocation: Invocation): Promise<string> {
	const { args, stdin, options, onFailure, onMissing } = invocation;
	let result: ProcessResult;
	try {
		result = await run(args, stdin, options);
	} catch (error) {
		if (error instanceof ProcessInterrupted) {
			throw new Error(
				onFailure(
					error.reason === "timeout"
						? `himalaya did not finish within ${options.timeoutMs / 1000} seconds`
						: "the call was cancelled before himalaya finished",
				),
			);
		}
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(onMissing);
		throw new Error(onFailure((error as Error).message));
	}
	if (result.exitCode !== 0) throw new Error(onFailure(reasonFrom(result)));
	return result.stdout;
}

interface Sender {
	readonly header: string;
	readonly domain: string;
}

function senderFrom(templateText: string, owner: string): Sender {
	const headerBlock = templateText.split(/\r?\n\r?\n/)[0] ?? "";
	const header = /^From:[ \t]*(.+)$/im.exec(headerBlock)?.[1]?.trim();
	const address = header === undefined ? undefined : (/<([^<>\s]+)>/.exec(header)?.[1] ?? header);
	if (header === undefined || address === undefined || !isAddress(address)) {
		throw new Error(
			`himalaya has no sender address for ${owner}, so nothing was sent. Open Plugins → Gmail to connect your mailbox.`,
		);
	}
	return { header, domain: address.slice(address.lastIndexOf("@") + 1) };
}

export async function sendEmail(email: Email, run: RunHimalaya, signal?: AbortSignal): Promise<string> {
	const accountArgs = accountFlag(email.account);
	const owner = email.account === null ? "your default account" : `the account "${email.account}"`;
	const sender = senderFrom(
		await runChecked(run, {
			args: ["template", "write", ...accountArgs],
			stdin: "",
			options: { signal, timeoutMs: LOOKUP_TIMEOUT_MS },
			onFailure: why =>
				`himalaya could not read the sender address of ${owner} (${why}), so nothing was sent. Open Plugins → Gmail to check that your mailbox is connected.`,
			onMissing: SEND_NOT_INSTALLED,
		}),
		owner,
	);
	const messageId = `<${randomUUID()}@${sender.domain}>`;
	await runChecked(run, {
		args: ["template", "send", ...accountArgs],
		stdin: buildTemplate(email, sender.header, messageId),
		options: { signal, timeoutMs: SEND_TIMEOUT_MS },
		onFailure: why =>
			`himalaya could not send the email (${why}). It may or may not have gone out: check the Sent folder before trying again.`,
		onMissing: SEND_NOT_INSTALLED,
	});
	return messageId;
}
