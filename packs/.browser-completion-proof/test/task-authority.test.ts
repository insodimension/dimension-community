import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createGuardedTaskEndpoint } from "../src/task-authority";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function endpoint(authorize: Parameters<typeof createGuardedTaskEndpoint>[1]) {
	const server = createServer();
	const upstream = new WebSocketServer({ server });
	const received: string[] = [];
	upstream.on("connection", socket => socket.on("message", bytes => {
		const message = bytes.toString();
		received.push(message);
		socket.send(message);
	}));
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(async () => {
		for (const client of upstream.clients) client.terminate();
		await new Promise<void>(resolve => upstream.close(() => resolve()));
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture listener");
	const gate = await createGuardedTaskEndpoint(`ws://127.0.0.1:${address.port}/cdp`, authorize);
	cleanup.push(gate.close);
	const worker = new WebSocket(gate.url);
	cleanup.push(() => worker.terminate());
	await new Promise<void>((resolve, reject) => {
		worker.once("open", resolve);
		worker.once("error", reject);
	});
	return { gate, worker, received };
}

test("an oversized first worker command closes the connection before authorization or forwarding", async () => {
	let authorizations = 0;
	let allowed = true;
	const assertCurrent = () => { if (!allowed) throw new Error("revoked"); };
	const { worker, received } = await endpoint(Object.assign(
		() => { authorizations++; assertCurrent(); },
		{ assertCurrent },
	));
	const closed = new Promise<void>(resolve => worker.once("close", () => resolve()));
	worker.send(JSON.stringify({
		id: 1,
		method: "Runtime.evaluate",
		params: { expression: "x".repeat(1024 * 1024 + 1) },
	}));
	await closed;
	expect(authorizations).toBe(0);
	expect(received).toEqual([]);
});

test("a queued CDP command is never forwarded after authorization rejects", async () => {
	let entered!: () => void;
	let release!: () => void;
	const checked = new Promise<void>(resolve => { entered = resolve; });
	const held = new Promise<void>(resolve => { release = resolve; });
	let allowed = true;
	const assertCurrent = () => { if (!allowed) throw new Error("revoked"); };
	const { worker, received } = await endpoint(Object.assign(async () => {
		entered();
		await held;
		assertCurrent();
	}, { assertCurrent }));
	worker.send('{"id":1,"method":"Page.navigate","params":{"url":"https://example.test"}}');
	await checked;
	allowed = false;
	release();
	await new Promise<void>(resolve => worker.once("close", resolve));
	expect(received).toEqual([]);
});

test("close fences an authorization already awaiting host authority", async () => {
	let entered!: () => void;
	let release!: () => void;
	const checked = new Promise<void>(resolve => { entered = resolve; });
	const held = new Promise<void>(resolve => { release = resolve; });
	let allowed = true;
	const assertCurrent = () => { if (!allowed) throw new Error("revoked"); };
	const { worker, gate, received } = await endpoint(Object.assign(
		async () => { entered(); await held; assertCurrent(); },
		{ assertCurrent },
	));
	worker.send('{"id":2,"method":"Runtime.evaluate"}');
	await checked;
	gate.close();
	release();
	await new Promise<void>(resolve => worker.once("close", resolve));
	expect(received).toEqual([]);
});

test("permission withdrawn after asynchronous refresh prevents forwarding", async () => {
	let allowed = true;
	const assertCurrent = () => { if (!allowed) throw new Error("revoked"); };
	const { worker, received } = await endpoint(Object.assign(async () => {
		assertCurrent();
		queueMicrotask(() => { allowed = false; });
	}, { assertCurrent }));
	const closed = new Promise<void>(resolve => worker.once("close", () => resolve()));
	worker.send('{"id":3,"method":"Runtime.evaluate","params":{"expression":"1 + 1"}}');
	await closed;
	expect(received).toEqual([]);
});
