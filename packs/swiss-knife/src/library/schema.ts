import type { SqlDriver } from "./driver";
import { LibraryError } from "./errors";
import type { WorkspaceResolver } from "./workspace-root";

export const SCHEMA_VERSION = 3;
export const DISCARDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
CREATE TABLE artifacts(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL COLLATE NOCASE, title TEXT, note TEXT, tags TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  width INTEGER, height INTEGER, duration_ms INTEGER,
  workspace TEXT, session_id TEXT,
  source TEXT NOT NULL CHECK(source IN ('present','stamp','human')),
  starred INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','missing','discarded')),
  created_at INTEGER NOT NULL, presented_at INTEGER NOT NULL,
  opened_at INTEGER, discarded_at INTEGER, thumb TEXT
);
CREATE INDEX artifacts_recent ON artifacts(presented_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_ws ON artifacts(workspace, presented_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_kind ON artifacts(kind, presented_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_live ON artifacts(state) WHERE state != 'discarded';
CREATE INDEX artifacts_name ON artifacts(name, id) WHERE state != 'discarded';
CREATE INDEX artifacts_size ON artifacts(size DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_opened ON artifacts(opened_at DESC, id) WHERE state != 'discarded';
CREATE INDEX artifacts_starred ON artifacts(presented_at DESC, id) WHERE starred = 1 AND state != 'discarded';
CREATE INDEX artifacts_discarded ON artifacts(discarded_at DESC, id) WHERE state = 'discarded';
CREATE VIRTUAL TABLE artifacts_fts USING fts5(name, title, note, tags, path,
  content='artifacts', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, name, title, note, tags, path)
  VALUES (new.rowid, new.name, new.title, new.note, new.tags, new.path);
END;
CREATE TRIGGER artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, name, title, note, tags, path)
  VALUES ('delete', old.rowid, old.name, old.title, old.note, old.tags, old.path);
END;
CREATE TRIGGER artifacts_fts_update AFTER UPDATE OF name, title, note, tags, path ON artifacts
WHEN old.name IS NOT new.name OR old.title IS NOT new.title OR old.note IS NOT new.note
  OR old.tags IS NOT new.tags OR old.path IS NOT new.path BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, name, title, note, tags, path)
  VALUES ('delete', old.rowid, old.name, old.title, old.note, old.tags, old.path);
  INSERT INTO artifacts_fts(rowid, name, title, note, tags, path)
  VALUES (new.rowid, new.name, new.title, new.note, new.tags, new.path);
END;
CREATE TABLE shares(
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  remote_id TEXT NOT NULL, base_url TEXT NOT NULL, key TEXT NOT NULL, owner_token TEXT NOT NULL,
  audience TEXT NOT NULL,
  version INTEGER NOT NULL, version_at INTEGER NOT NULL, allow_comments INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
  comments_seen_at INTEGER
);
CREATE INDEX shares_artifact ON shares(artifact_id, created_at);
CREATE INDEX shares_live ON shares(artifact_id) WHERE revoked_at IS NULL;
CREATE TABLE comments(
  id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  author TEXT NOT NULL, body TEXT NOT NULL, anchor TEXT, version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, read_at INTEGER, resolved_at INTEGER
);
CREATE INDEX comments_share ON comments(share_id, created_at);
CREATE INDEX comments_unread ON comments(share_id) WHERE read_at IS NULL;
`;

type Migration = (db: SqlDriver, workspaceOf: WorkspaceResolver) => void;

const MIGRATIONS: Readonly<Record<number, Migration>> = {
	1: db =>
		db.exec(`
ALTER TABLE shares ADD COLUMN version_at INTEGER NOT NULL DEFAULT 0;
UPDATE shares SET version_at = created_at;
`),
	2: rehomeWorkspaces,
};

interface VersionRow {
	readonly user_version: number;
}

function readVersion(db: SqlDriver): number {
	const statement = db.prepare("PRAGMA user_version");
	try {
		return statement.get<VersionRow>()?.user_version ?? 0;
	} finally {
		statement.finalize();
	}
}

function upgrade(db: SqlDriver, workspaceOf: WorkspaceResolver): void {
	const version = readVersion(db);
	if (version === 0) {
		db.exec(SCHEMA);
	} else {
		for (let step = version; step < SCHEMA_VERSION; step++) {
			const migration = MIGRATIONS[step];
			if (migration === undefined) throw new LibraryError(`library.db is schema version ${version} and has no upgrade path to ${SCHEMA_VERSION}.`);
			migration(db, workspaceOf);
		}
	}
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function prepareDatabase(db: SqlDriver, now: number, workspaceOf: WorkspaceResolver): void {
	if (readVersion(db) < SCHEMA_VERSION) {
		db.exec("BEGIN IMMEDIATE");
		try {
			if (readVersion(db) < SCHEMA_VERSION) upgrade(db, workspaceOf);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	const version = readVersion(db);
	if (version !== SCHEMA_VERSION) {
		throw new LibraryError(`library.db is schema version ${version}; this Dimension reads version ${SCHEMA_VERSION}. Update Dimension.`);
	}
	const purge = db.prepare("DELETE FROM artifacts WHERE state = 'discarded' AND discarded_at < ?");
	try {
		purge.run(now - DISCARDED_RETENTION_MS);
	} finally {
		purge.finalize();
	}
}

function rehomeWorkspaces(db: SqlDriver, workspaceOf: WorkspaceResolver): void {
	const distinct = db.prepare("SELECT DISTINCT workspace FROM artifacts WHERE workspace IS NOT NULL");
	let moves: [from: string, to: string][];
	try {
		moves = distinct
			.all<{ readonly workspace: string }>()
			.map(({ workspace }): [string, string] => [workspace, workspaceOf(workspace)])
			.filter(([from, to]) => from !== to);
	} finally {
		distinct.finalize();
	}
	if (moves.length === 0) return;
	const update = db.prepare("UPDATE artifacts SET workspace = ? WHERE workspace = ?");
	try {
		for (const [from, to] of moves) update.run(to, from);
	} finally {
		update.finalize();
	}
}
