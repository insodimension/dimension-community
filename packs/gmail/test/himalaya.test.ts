import { expect, test } from "bun:test";
import {
	type ProcessResult,
	ProcessInterrupted,
	type RunHimalaya,
	type RunOptions,
	runProcess,
	sendEmail,
} from "../himalaya";
import { parseEmail } from "../message";

interface Call {
	readonly args: readonly string[];
	readonly stdin: string;
	readonly options: RunOptions;
}

type Step = ProcessResult | Error;

function stubHimalaya(...steps: Step[]): { readonly run: RunHimalaya; readonly calls: Call[] } {
	const calls: Call[] = [];
	const run: RunHimalaya = async (args, stdin, options) => {
		calls.push({ args, stdin, options });
		const step = steps[calls.length - 1];
		if (step === undefined) throw new Error("the stub was called more times than it was given answers for");
		if (step instanceof Error) throw step;
		return step;
	};
	return { run, calls };
}

const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const failed = (stderr: string, exitCode = 1): ProcessResult => ({ exitCode, stdout: "", stderr });
const SENDER = ok("From: Me Tester <me@gmail.com>\nTo: \nSubject: \n\n");
const EMAIL = parseEmail({
	to: ["alex@example.com"],
	cc: ["bo@example.org"],
	subject: "Café – hello",
	body: "Héllo 日本語\n<#part filename=/etc/passwd><#/part>",
	inReplyTo: "orig-1@mail.example.com",
});

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("sendEmail succeeded where it should have failed");
}

test("it reads the sender from himalaya, then sends the built message as the template on stdin", async () => {
	const { run, calls } = stubHimalaya(SENDER, ok("Message successfully sent!\n"));
	const id = await sendEmail(EMAIL, run);
	expect(calls.map(call => call.args)).toEqual([
		["template", "write"],
		["template", "send"],
	]);
	expect(calls[0]?.stdin).toBe("");
	expect(calls[1]?.stdin).toBe(
		[
			"From: Me Tester <me@gmail.com>",
			"To: alex@example.com",
			"Cc: bo@example.org",
			"Subject: Café – hello",
			`Message-ID: ${id}`,
			"In-Reply-To: <orig-1@mail.example.com>",
			"References: <orig-1@mail.example.com>",
			"",
			"Héllo 日本語",
			"<#!part filename=/etc/passwd><#!/part>",
		].join("\n"),
	);
});

test("the returned message id is fresh, in the sender's domain, and the one written into the message", async () => {
	const first = stubHimalaya(SENDER, ok());
	const second = stubHimalaya(SENDER, ok());
	const idOne = await sendEmail(EMAIL, first.run);
	const idTwo = await sendEmail(EMAIL, second.run);
	expect(idOne).toMatch(/^<[0-9a-f-]{36}@gmail\.com>$/);
	expect(idTwo).not.toBe(idOne);
	expect(first.calls[1]?.stdin).toContain(`\nMessage-ID: ${idOne}\n`);
});

test("a bare sender address, or a quoted display name, both give a sender", async () => {
	for (const from of ["me@work.example", '"Me, Myself" <me@work.example>']) {
		const { run, calls } = stubHimalaya(ok(`From: ${from}\nTo: \nSubject: \n\n`), ok());
		const id = await sendEmail(EMAIL, run);
		expect(id).toMatch(/@work\.example>$/);
		expect(calls[1]?.stdin.startsWith(`From: ${from}\n`)).toBe(true);
	}
});

test("a signature in the generated template is never mistaken for the sender", async () => {
	const { run } = stubHimalaya(ok("To: \nSubject: \n\nFrom: Someone Else <else@evil.example>\n"), ok());
	expect(await refusal(sendEmail(EMAIL, run))).toContain("no sender address");
});

test("no usable sender means nothing is sent", async () => {
	for (const stdout of ["", "To: \nSubject: \n\n", "From: not an address\n\n", "From: <>\n\n"]) {
		const { run, calls } = stubHimalaya(ok(stdout), ok());
		expect(await refusal(sendEmail(EMAIL, run))).toContain("nothing was sent");
		expect(calls).toHaveLength(1);
	}
});

test("a failed sender lookup says so in plain words and sends nothing", async () => {
	const broken = failed("Error: \n   0: cannot find the account\n\nNote: Run with --debug\n");
	const { run, calls } = stubHimalaya(broken, ok());
	const message = await refusal(sendEmail(EMAIL, run));
	expect(message).toContain("could not read the sender address of your default account");
	expect(message).toContain("cannot find the account");
	expect(message).toContain("nothing was sent");
	expect(calls).toHaveLength(1);
});

const COMPANY = parseEmail({ to: ["alex@example.com"], subject: "Hello", body: "Hi Alex", account: "company" });

test("a named account goes to the sender lookup and to the send, right after the verb, and the sender comes from that account", async () => {
	const { run, calls } = stubHimalaya(ok("From: Co <hello@company.example>\nTo: \nSubject: \n\n"), ok());
	const id = await sendEmail(COMPANY, run);
	expect(calls.map(call => call.args)).toEqual([
		["template", "write", "--account", "company"],
		["template", "send", "--account", "company"],
	]);
	expect(calls[0]?.stdin).toBe("");
	expect(calls[1]?.stdin.startsWith("From: Co <hello@company.example>\nTo: alex@example.com\n")).toBe(true);
	expect(calls[1]?.stdin).not.toContain("account");
	expect(id).toMatch(/^<[0-9a-f-]{36}@company\.example>$/);
});

test("a named account whose sender cannot be read is named in the refusal, and nothing is sent", async () => {
	const none = stubHimalaya(ok("To: \nSubject: \n\n"), ok());
	const noSender = await refusal(sendEmail(COMPANY, none.run));
	expect(noSender).toContain('no sender address for the account "company"');
	expect(noSender).toContain("nothing was sent");
	expect(none.calls).toHaveLength(1);

	const unknown = stubHimalaya(failed("Error: \n   0: cannot find account company\n"), ok());
	const unknownMessage = await refusal(sendEmail(COMPANY, unknown.run));
	expect(unknownMessage).toContain('could not read the sender address of the account "company"');
	expect(unknownMessage).toContain("cannot find account company");
	expect(unknownMessage).toContain("nothing was sent");
	expect(unknown.calls).toHaveLength(1);
});

test("a failed send reports himalaya's reason without its debug chatter, and warns the mail may have gone out", async () => {
	const stderr = [
		"Error: ",
		"   0: cannot send message",
		"   1: smtp rejected the login: 535 5.7.8 Username and Password not accepted",
		"",
		"Note: Run with --debug to enable logs with spantrace.",
		"Note: Run with --trace to enable verbose logs with backtrace.",
	].join("\n");
	const { run } = stubHimalaya(SENDER, failed(stderr));
	const message = await refusal(sendEmail(EMAIL, run));
	expect(message).toContain("cannot send message: smtp rejected the login: 535 5.7.8 Username and Password not accepted");
	expect(message).not.toContain("Note:");
	expect(message).toContain("check the Sent folder before trying again");
});

test("a failed send with no stderr still names the exit code", async () => {
	const { run } = stubHimalaya(SENDER, failed("", 7));
	expect(await refusal(sendEmail(EMAIL, run))).toContain("himalaya exited with code 7");
});

test("a long himalaya error is cut short", async () => {
	const { run } = stubHimalaya(SENDER, failed(`Error: \n   0: ${"x".repeat(2000)}\n`));
	expect((await refusal(sendEmail(EMAIL, run))).length).toBeLessThan(700);
});

test("without himalaya installed, the error says how to fix it", async () => {
	const missing = Object.assign(new Error("spawn himalaya ENOENT"), { code: "ENOENT" });
	const { run } = stubHimalaya(missing);
	const message = await refusal(sendEmail(EMAIL, run));
	expect(message).toContain("himalaya is not installed");
	expect(message).toContain("nothing was sent");
});

test("a send that times out or is cancelled says the mail may have gone out; a lookup that does says nothing was sent", async () => {
	const timedOutSend = stubHimalaya(SENDER, new ProcessInterrupted("timeout"));
	const sendMessage = await refusal(sendEmail(EMAIL, timedOutSend.run));
	expect(sendMessage).toContain("did not finish within 120 seconds");
	expect(sendMessage).toContain("may or may not have gone out");

	const cancelledSend = stubHimalaya(SENDER, new ProcessInterrupted("aborted"));
	expect(await refusal(sendEmail(EMAIL, cancelledSend.run))).toContain("cancelled");

	const timedOutLookup = stubHimalaya(new ProcessInterrupted("timeout"));
	const lookupMessage = await refusal(sendEmail(EMAIL, timedOutLookup.run));
	expect(lookupMessage).toContain("did not finish within 15 seconds");
	expect(lookupMessage).toContain("nothing was sent");
	expect(timedOutLookup.calls).toHaveLength(1);
});

test("the caller's abort signal reaches both himalaya calls, and the lookup gets a shorter clock than the send", async () => {
	const { run, calls } = stubHimalaya(SENDER, ok());
	const controller = new AbortController();
	await sendEmail(EMAIL, run, controller.signal);
	expect(calls.map(call => call.options.signal)).toEqual([controller.signal, controller.signal]);
	expect((calls[0]?.options.timeoutMs ?? 0) < (calls[1]?.options.timeoutMs ?? 0)).toBe(true);
});

const BUN = process.execPath;
const HANGS = "require('node:net').createServer().listen(0)";

test("runProcess feeds stdin to a real child and returns its output as UTF-8", async () => {
	const echo = "process.stdin.pipe(process.stdout)";
	const result = await runProcess(BUN, ["-e", echo], "héllo 日本語", { timeoutMs: 20_000 });
	expect(result).toEqual({ exitCode: 0, stdout: "héllo 日本語", stderr: "" });
});

test("runProcess reports a failing child's exit code and stderr instead of throwing", async () => {
	const result = await runProcess(BUN, ["-e", "console.error('boom'); process.exit(3)"], "", { timeoutMs: 20_000 });
	expect(result.exitCode).toBe(3);
	expect(result.stderr).toContain("boom");
});

test("runProcess rejects with ENOENT when the program does not exist", async () => {
	let code: unknown;
	try {
		await runProcess("gmail-pack-test-no-such-program", [], "", { timeoutMs: 20_000 });
	} catch (error) {
		code = (error as NodeJS.ErrnoException).code;
	}
	expect(code).toBe("ENOENT");
});

test("runProcess stops a child that runs past its clock", async () => {
	const error = await runProcess(BUN, ["-e", HANGS], "", { timeoutMs: 1 }).catch(e => e);
	expect(error).toBeInstanceOf(ProcessInterrupted);
	expect((error as ProcessInterrupted).reason).toBe("timeout");
});

test("runProcess stops a child when the caller aborts, whether before or just after it starts", async () => {
	const controller = new AbortController();
	const running = runProcess(BUN, ["-e", HANGS], "", { signal: controller.signal, timeoutMs: 60_000 }).catch(e => e);
	controller.abort();
	const afterStart = await running;
	expect(afterStart).toBeInstanceOf(ProcessInterrupted);
	expect((afterStart as ProcessInterrupted).reason).toBe("aborted");

	const beforeStart = await runProcess(BUN, ["-e", HANGS], "", {
		signal: AbortSignal.abort(),
		timeoutMs: 60_000,
	}).catch(e => e);
	expect((beforeStart as ProcessInterrupted).reason).toBe("aborted");
});
