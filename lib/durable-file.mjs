import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const BACKUP_SUFFIX = ".bak";
const RENAME_RETRY_CODES = { EPERM: true, EBUSY: true, EACCES: true };
const RENAME_BACKOFF_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 256, 256, 256, 256];
const syncSleepCell = new Int32Array(new SharedArrayBuffer(4));
const foldersHaveNoFsync = process.platform === "win32";
const filesHaveNoModes = process.platform === "win32";

export class DurableFileUnreadableError extends Error {
	constructor(filePath, reason, quarantinedAt) {
		super(
			`${filePath} could not be read (${reason}) and has no readable backup; it was left in place${
				quarantinedAt ? ` and copied to ${quarantinedAt}` : ""
			}. Restore it before writing.`,
		);
		this.name = "DurableFileUnreadableError";
		this.filePath = filePath;
		this.reason = reason;
		this.quarantinedAt = quarantinedAt;
	}
}

export function backupPathOf(filePath) {
	return `${filePath}${BACKUP_SUFFIX}`;
}

export function parseJsonBytes(bytes) {
	return JSON.parse(bytes.toString("utf8"));
}

const codeOf = error => (typeof error === "object" && error !== null ? error.code : undefined);
const isMissing = error => codeOf(error) === "ENOENT";
const isHeldByAnotherProcess = error => Object.hasOwn(RENAME_RETRY_CODES, codeOf(error));

const stagingPathOf = filePath => `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

const toBuffer = data =>
	typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

function defectOf(bytes) {
	if (bytes.length === 0) return "zero-length";
	for (let index = 0; index < bytes.length; index++) if (bytes[index] !== 0) return undefined;
	return "NUL-filled";
}

function parsesWhole(bytes, parse) {
	if (defectOf(bytes) !== undefined) return false;
	try {
		parse(bytes);
		return true;
	} catch {
		return false;
	}
}

const permissionsOf = stats => (stats === undefined || filesHaveNoModes ? undefined : stats.mode & 0o777);

async function existingMode(filePath) {
	if (filesHaveNoModes) return undefined;
	try {
		return permissionsOf(await fs.promises.stat(filePath));
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

const narrowerMode = (left, right) => (left === undefined ? right : right === undefined ? left : left & right);

export function fsyncDirectorySync(directory) {
	if (foldersHaveNoFsync) return;
	let descriptor;
	try {
		descriptor = fs.openSync(directory, "r");
		fs.fsyncSync(descriptor);
	} catch {
		return;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

async function fsyncDirectory(directory) {
	if (foldersHaveNoFsync) return;
	let handle;
	try {
		handle = await fs.promises.open(directory, "r");
		await handle.sync();
	} catch {
		return;
	} finally {
		await handle?.close();
	}
}

function stageSync(stagedPath, bytes, mode) {
	const descriptor = fs.openSync(stagedPath, "wx", mode);
	try {
		if (mode !== undefined && !filesHaveNoModes) fs.fchmodSync(descriptor, mode);
		let offset = 0;
		while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

async function stage(stagedPath, bytes, mode) {
	const handle = await fs.promises.open(stagedPath, "wx", mode);
	try {
		if (mode !== undefined && !filesHaveNoModes) await handle.chmod(mode);
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function renameOverHeldTargetSync(from, to) {
	for (const backoffMs of RENAME_BACKOFF_MS) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (error) {
			if (!isHeldByAnotherProcess(error)) throw error;
		}
		Atomics.wait(syncSleepCell, 0, 0, backoffMs);
	}
	fs.renameSync(from, to);
}

async function renameOverHeldTarget(from, to) {
	for (const backoffMs of RENAME_BACKOFF_MS) {
		try {
			await fs.promises.rename(from, to);
			return;
		} catch (error) {
			if (!isHeldByAnotherProcess(error)) throw error;
		}
		await new Promise(resolve => setTimeout(resolve, backoffMs));
	}
	await fs.promises.rename(from, to);
}

function publishSync(targetPath, bytes, mode) {
	const stagedPath = stagingPathOf(targetPath);
	try {
		stageSync(stagedPath, bytes, mode);
		renameOverHeldTargetSync(stagedPath, targetPath);
	} catch (error) {
		fs.rmSync(stagedPath, { force: true });
		throw error;
	}
}

async function publish(targetPath, bytes, mode) {
	const stagedPath = stagingPathOf(targetPath);
	try {
		await stage(stagedPath, bytes, mode);
		await renameOverHeldTarget(stagedPath, targetPath);
	} catch (error) {
		await fs.promises.rm(stagedPath, { force: true });
		throw error;
	}
}

function readPreviousSync(filePath) {
	let descriptor;
	try {
		descriptor = fs.openSync(filePath, "r");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	try {
		return { mode: permissionsOf(fs.fstatSync(descriptor)), bytes: fs.readFileSync(descriptor) };
	} finally {
		fs.closeSync(descriptor);
	}
}

async function readPrevious(filePath) {
	let handle;
	try {
		handle = await fs.promises.open(filePath, "r");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	try {
		return { mode: permissionsOf(await handle.stat()), bytes: await handle.readFile() };
	} finally {
		await handle.close();
	}
}

export function writeFileAtomicSync(filePath, data, options = {}) {
	const directory = path.dirname(filePath);
	fs.mkdirSync(directory, { recursive: true });
	const bytes = toBuffer(data);
	const backup = options.backup;
	if (backup === undefined) {
		publishSync(filePath, bytes, options.mode ?? permissionsOf(fs.statSync(filePath, { throwIfNoEntry: false })));
	} else {
		const previous = readPreviousSync(filePath);
		if (previous !== undefined && parsesWhole(previous.bytes, backup.parse)) {
			publishSync(backupPathOf(filePath), previous.bytes, narrowerMode(options.mode, previous.mode));
		}
		publishSync(filePath, bytes, options.mode ?? previous?.mode);
	}
	fsyncDirectorySync(directory);
}

export async function writeFileAtomic(filePath, data, options = {}) {
	const directory = path.dirname(filePath);
	await fs.promises.mkdir(directory, { recursive: true });
	const bytes = toBuffer(data);
	const backup = options.backup;
	if (backup === undefined) {
		await publish(filePath, bytes, options.mode ?? (await existingMode(filePath)));
	} else {
		const previous = await readPrevious(filePath);
		if (previous !== undefined && parsesWhole(previous.bytes, backup.parse)) {
			await publish(backupPathOf(filePath), previous.bytes, narrowerMode(options.mode, previous.mode));
		}
		await publish(filePath, bytes, options.mode ?? previous?.mode);
	}
	await fsyncDirectory(directory);
}

function readIfPresentSync(filePath) {
	try {
		return fs.readFileSync(filePath);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

async function readIfPresent(filePath) {
	try {
		return await fs.promises.readFile(filePath);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

const quarantineName = (filePath, stats) =>
	`${filePath}.corrupt-${stats ? Math.trunc(stats.mtimeMs).toString(36) : Date.now().toString(36)}`;

const describeFailure = error => (error instanceof Error ? error.message : String(error));

function quarantineSync(filePath, bytes) {
	try {
		const stats = fs.statSync(filePath, { throwIfNoEntry: false });
		const target = quarantineName(filePath, stats);
		if (fs.lstatSync(target, { throwIfNoEntry: false }) === undefined) publishSync(target, bytes, permissionsOf(stats));
		return target;
	} catch (error) {
		console.error(`Could not keep a copy of the unreadable ${filePath}: ${describeFailure(error)}`);
		return undefined;
	}
}

async function quarantine(filePath, bytes) {
	try {
		const stats = await fs.promises.stat(filePath).catch(() => undefined);
		const target = quarantineName(filePath, stats);
		const existing = await fs.promises.lstat(target).catch(error => {
			if (isMissing(error)) return undefined;
			throw error;
		});
		if (existing === undefined) await publish(target, bytes, permissionsOf(stats));
		return target;
	} catch (error) {
		console.error(`Could not keep a copy of the unreadable ${filePath}: ${describeFailure(error)}`);
		return undefined;
	}
}

function parseBytes(bytes, parse) {
	const defect = defectOf(bytes);
	if (defect !== undefined) return { ok: false, reason: defect };
	try {
		return { ok: true, value: parse(bytes) };
	} catch (error) {
		return { ok: false, reason: describeFailure(error) };
	}
}

function recoverFromBackup(filePath, reason, quarantinedAt, backup, parse) {
	const restored = backup === undefined ? undefined : parseBytes(backup, parse);
	const kept = quarantinedAt ? ` (kept as ${quarantinedAt})` : "";
	if (restored?.ok) {
		console.error(`${filePath} was unreadable (${reason})${kept}; read from its backup.`);
		return restored.value;
	}
	console.error(`${filePath} is unreadable (${reason})${kept} and has no readable backup.`);
	throw new DurableFileUnreadableError(filePath, reason, quarantinedAt);
}

export function readDurableFileSync(filePath, parse, options = {}) {
	const bytes = readIfPresentSync(filePath);
	if (bytes === undefined) {
		const backup = readIfPresentSync(backupPathOf(filePath));
		if (backup === undefined) return undefined;
		return recoverFromBackup(filePath, "missing while its backup exists", undefined, backup, parse);
	}
	const parsed = parseBytes(bytes, parse);
	if (parsed.ok) return parsed.value;
	const quarantinedAt = options.keepDamagedCopy === false ? undefined : quarantineSync(filePath, bytes);
	return recoverFromBackup(filePath, parsed.reason, quarantinedAt, readIfPresentSync(backupPathOf(filePath)), parse);
}

export async function readDurableFile(filePath, parse, options = {}) {
	const bytes = await readIfPresent(filePath);
	if (bytes === undefined) {
		const backup = await readIfPresent(backupPathOf(filePath));
		if (backup === undefined) return undefined;
		return recoverFromBackup(filePath, "missing while its backup exists", undefined, backup, parse);
	}
	const parsed = parseBytes(bytes, parse);
	if (parsed.ok) return parsed.value;
	const quarantinedAt = options.keepDamagedCopy === false ? undefined : await quarantine(filePath, bytes);
	return recoverFromBackup(filePath, parsed.reason, quarantinedAt, await readIfPresent(backupPathOf(filePath)), parse);
}

export async function removeDurableFile(filePath) {
	const directory = path.dirname(filePath);
	await fs.promises.rm(backupPathOf(filePath), { force: true });
	await fsyncDirectory(directory);
	await fs.promises.rm(filePath, { force: true });
	await fsyncDirectory(directory);
}
