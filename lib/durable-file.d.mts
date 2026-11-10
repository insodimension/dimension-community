export interface DurableBackupOptions {
	readonly parse: (bytes: Buffer) => unknown;
}

export interface DurableWriteOptions {
	readonly mode?: number;
	readonly backup?: DurableBackupOptions;
}

export interface DurableReadOptions {
	readonly keepDamagedCopy?: boolean;
}

export declare class DurableFileUnreadableError extends Error {
	readonly filePath: string;
	readonly reason: string;
	readonly quarantinedAt: string | undefined;
	constructor(filePath: string, reason: string, quarantinedAt: string | undefined);
}

export declare function backupPathOf(filePath: string): string;
export declare function parseJsonBytes(bytes: Buffer): unknown;
export declare function fsyncDirectorySync(directory: string): void;
export declare function writeFileAtomicSync(filePath: string, data: string | Uint8Array, options?: DurableWriteOptions): void;
export declare function writeFileAtomic(filePath: string, data: string | Uint8Array, options?: DurableWriteOptions): Promise<void>;
export declare function readDurableFileSync<T>(filePath: string, parse: (bytes: Buffer) => T, options?: DurableReadOptions): T | undefined;
export declare function readDurableFile<T>(filePath: string, parse: (bytes: Buffer) => T, options?: DurableReadOptions): Promise<T | undefined>;
export declare function removeDurableFile(filePath: string): Promise<void>;
export declare function writeSecretFileAtomic(filePath: string, data: string | Uint8Array, options?: Pick<DurableWriteOptions, "mode">): Promise<void>;
export declare function removeSecretFile(filePath: string): Promise<void>;
