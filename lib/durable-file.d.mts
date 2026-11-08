export interface DurableBackupOptions {
	readonly isIntact?: (bytes: Buffer) => boolean;
}

export interface DurableWriteOptions {
	readonly mode?: number;
	readonly backup?: boolean | DurableBackupOptions;
}

export type DurableRead<T> =
	| { readonly state: "absent" }
	| { readonly state: "ok"; readonly value: T; readonly source: "primary" | "backup" };

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
export declare function readDurableFileSync<T>(filePath: string, parse: (bytes: Buffer) => T): DurableRead<T>;
export declare function readDurableFile<T>(filePath: string, parse: (bytes: Buffer) => T): Promise<DurableRead<T>>;
export declare function removeDurableFile(filePath: string): Promise<void>;
