/**
 * PaperDb: the sidecar's SQLite store (.paper/paper.db) on node:sqlite DatabaseSync.
 *
 * Tables
 *   units(id PK, file, json, removed)                    every unit ever seen; removed = 1 keeps history queryable
 *   versions(sentence_id, version, json, origin, ts)     PK(sentence_id, version); mirrored to history.jsonl
 *   lint(id PK, file, sentence_id, scope, json, dismissed)
 *   lint_dismissed(id PK)                                dismissals survive a re-lint (same flag id)
 *   orphans(id PK, file, json)                           units that could not be re-anchored (metadata kept)
 *   kv(key PK, value)                                    last-saved text snapshots, agent sessions, cursors
 *
 * Journal mode WAL, synchronous NORMAL (the jsonl history is the durable log; the db is a cache of it plus
 * the live units). Only the ExperimentalWarning that node:sqlite prints on load is suppressed.
 *
 * Orphans: saveOrphans() stores units that lost their anchor (and marks them removed in `units`, so
 * units(file) returns live units only); upsertUnits() of a unit with the same id re-attaches it (it is
 * deleted from `orphans`). replaceOrphans(file, list) replaces a file's orphan list after a re-anchor.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncT, StatementSync } from 'node:sqlite';
import { AI_ORIGINS, LintFlag, SentenceUnit, SentenceVersion } from '@paper-copilot/core';
import type { Logger, PaperDb } from '../contracts';

type SqliteModule = typeof import('node:sqlite');

let sqliteModule: SqliteModule | null = null;

/** Load node:sqlite once, hiding only its ExperimentalWarning (every other warning passes through). */
export function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type ?? (warning as Error)?.name;
    if (typeof msg === 'string' && /sqlite/i.test(msg) && (type === 'ExperimentalWarning' || /experimental/i.test(msg))) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    const mod = process.getBuiltinModule('node:sqlite') as SqliteModule | undefined;
    if (!mod) throw new Error('node:sqlite is not available (Node >= 22.13 is required)');
    sqliteModule = mod;
    return mod;
  } finally {
    process.emitWarning = original;
  }
}

export interface PaperDbExt extends PaperDb {
  /** Replace the orphan list of one file. */
  replaceOrphans(file: string, units: SentenceUnit[]): void;
  /** Every unit stored for a file, live and removed (removed flagged). */
  allUnitsOf(file: string): Array<{ unit: SentenceUnit; removed: boolean }>;
  /** Every live unit of every file. */
  liveUnits(): SentenceUnit[];
  /** Files with stored units. */
  filesWithUnits(): string[];
  /** Forget an orphan for good (the author discarded it). History stays. */
  discardOrphan(id: string): void;
  readonly path: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  json TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS units_file ON units(file, removed);
CREATE TABLE IF NOT EXISTS versions (
  sentence_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  origin TEXT NOT NULL,
  ts TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (sentence_id, version)
);
CREATE TABLE IF NOT EXISTS lint (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  sentence_id TEXT,
  scope TEXT NOT NULL DEFAULT 'sentences',
  json TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS lint_file ON lint(file, scope);
CREATE TABLE IF NOT EXISTS lint_dismissed (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS orphans (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orphans_file ON orphans(file);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const AI_ORIGIN_LIST = AI_ORIGINS.map((o) => `'${o}'`).join(',');

function parseUnit(json: string, log?: Logger): SentenceUnit | null {
  try {
    const p = SentenceUnit.safeParse(JSON.parse(json));
    if (p.success) return p.data;
    log?.warn('db: skipping an invalid unit row', p.error.message.slice(0, 300));
  } catch (e) {
    log?.warn('db: skipping an unreadable unit row', String(e));
  }
  return null;
}

function parseVersion(json: string, log?: Logger): SentenceVersion | null {
  try {
    const p = SentenceVersion.safeParse(JSON.parse(json));
    if (p.success) return p.data;
    log?.warn('db: skipping an invalid version row', p.error.message.slice(0, 300));
  } catch (e) {
    log?.warn('db: skipping an unreadable version row', String(e));
  }
  return null;
}

function parseFlag(json: string, log?: Logger): LintFlag | null {
  try {
    const p = LintFlag.safeParse(JSON.parse(json));
    if (p.success) return p.data;
  } catch (e) {
    log?.debug('db: skipping an unreadable lint row', String(e));
  }
  return null;
}

/** Sort units in document order (start, then end). */
function byPosition(a: SentenceUnit, b: SentenceUnit): number {
  return a.start - b.start || a.end - b.end;
}

export function createPaperDb(path: string, log?: Logger): PaperDbExt {
  const { DatabaseSync } = loadSqlite();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db: DatabaseSyncT = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map<string, StatementSync>();
  const st = (sql: string): StatementSync => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };

  let depth = 0;
  let closed = false;
  const transaction = <T>(fn: () => T): T => {
    if (depth > 0) {
      // nested: savepoint so an inner failure does not abort the outer transaction
      const name = `sp${depth}`;
      depth++;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const r = fn();
        db.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    }
    depth++;
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      depth--;
    }
  };

  const rowsOf = <T>(rows: unknown[], parse: (json: string) => T | null): T[] => {
    const out: T[] = [];
    for (const r of rows) {
      const v = parse(String((r as { json: unknown }).json));
      if (v) out.push(v);
    }
    return out;
  };

  const dismissedSet = (): Set<string> => new Set((st('SELECT id FROM lint_dismissed').all() as Array<{ id: string }>).map((r) => r.id));

  const api: PaperDbExt = {
    path,
    units(file) {
      return rowsOf(st('SELECT json FROM units WHERE file = ? AND removed = 0').all(file), (j) => parseUnit(j, log)).sort(byPosition);
    },
    unit(id) {
      const r = st('SELECT json FROM units WHERE id = ?').get(id) as { json: string } | undefined;
      if (r) return parseUnit(r.json, log) ?? undefined;
      const o = st('SELECT json FROM orphans WHERE id = ?').get(id) as { json: string } | undefined;
      return o ? (parseUnit(o.json, log) ?? undefined) : undefined;
    },
    upsertUnits(units) {
      if (units.length === 0) return;
      transaction(() => {
        const up = st('INSERT INTO units(id, file, json, removed) VALUES (?, ?, ?, 0) ON CONFLICT(id) DO UPDATE SET file = excluded.file, json = excluded.json, removed = 0');
        const del = st('DELETE FROM orphans WHERE id = ?');
        for (const u of units) {
          up.run(u.id, u.file, JSON.stringify(u));
          del.run(u.id);
        }
      });
    },
    markRemoved(ids) {
      if (ids.length === 0) return;
      transaction(() => {
        const s = st('UPDATE units SET removed = 1 WHERE id = ?');
        for (const id of ids) s.run(id);
      });
    },
    saveOrphans(units) {
      if (units.length === 0) return;
      transaction(() => {
        const up = st('INSERT INTO orphans(id, file, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET file = excluded.file, json = excluded.json');
        const keep = st('INSERT INTO units(id, file, json, removed) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET json = excluded.json, removed = 1');
        for (const u of units) {
          const o = { ...u, orphaned: true };
          const json = JSON.stringify(o);
          up.run(o.id, o.file, json);
          keep.run(o.id, o.file, json);
        }
      });
    },
    replaceOrphans(file, units) {
      transaction(() => {
        st('DELETE FROM orphans WHERE file = ?').run(file);
        api.saveOrphans(units.filter((u) => u.file === file));
      });
    },
    orphans(file) {
      return rowsOf(st('SELECT json FROM orphans WHERE file = ?').all(file), (j) => parseUnit(j, log)).sort(byPosition);
    },
    discardOrphan(id) {
      st('DELETE FROM orphans WHERE id = ?').run(id);
    },
    allUnitsOf(file) {
      const out: Array<{ unit: SentenceUnit; removed: boolean }> = [];
      for (const r of st('SELECT json, removed FROM units WHERE file = ?').all(file) as Array<{ json: string; removed: number }>) {
        const u = parseUnit(r.json, log);
        if (u) out.push({ unit: u, removed: Number(r.removed) === 1 });
      }
      return out;
    },
    liveUnits() {
      return rowsOf(st('SELECT json FROM units WHERE removed = 0 ORDER BY file').all(), (j) => parseUnit(j, log));
    },
    filesWithUnits() {
      return (st('SELECT DISTINCT file FROM units WHERE removed = 0 ORDER BY file').all() as Array<{ file: string }>).map((r) => r.file);
    },
    appendVersions(versions) {
      if (versions.length === 0) return;
      transaction(() => {
        const s = st('INSERT OR REPLACE INTO versions(sentence_id, version, origin, ts, json) VALUES (?, ?, ?, ?, ?)');
        for (const v of versions) s.run(v.sentenceId, v.version, v.origin, v.ts, JSON.stringify(v));
      });
    },
    versions(id) {
      return rowsOf(st('SELECT json FROM versions WHERE sentence_id = ? ORDER BY version').all(id), (j) => parseVersion(j, log));
    },
    lastVersion(id) {
      const r = st('SELECT json FROM versions WHERE sentence_id = ? ORDER BY version DESC LIMIT 1').get(id) as { json: string } | undefined;
      return r ? (parseVersion(r.json, log) ?? undefined) : undefined;
    },
    lastAiVersion(id) {
      const r = st(`SELECT json FROM versions WHERE sentence_id = ? AND origin IN (${AI_ORIGIN_LIST}) ORDER BY version DESC LIMIT 1`).get(id) as { json: string } | undefined;
      return r ? (parseVersion(r.json, log) ?? undefined) : undefined;
    },
    allVersions() {
      return rowsOf(st('SELECT json FROM versions ORDER BY ts, sentence_id, version').all(), (j) => parseVersion(j, log));
    },
    setLint(file, flags, scope, sentenceIds) {
      transaction(() => {
        if (scope === 'document') {
          st("DELETE FROM lint WHERE file = ? AND scope = 'document'").run(file);
        } else {
          const del = st("DELETE FROM lint WHERE file = ? AND scope = 'sentences' AND sentence_id = ?");
          for (const id of new Set(sentenceIds)) del.run(file, id);
          // flags without a sentence id in a sentence pass replace the previous ones of the same kind
          if (flags.some((f) => f.sentenceId === null)) st("DELETE FROM lint WHERE file = ? AND scope = 'sentences' AND sentence_id IS NULL").run(file);
        }
        const dismissed = dismissedSet();
        const ins = st('INSERT OR REPLACE INTO lint(id, file, sentence_id, scope, json, dismissed) VALUES (?, ?, ?, ?, ?, ?)');
        for (const f of flags) {
          const d = f.dismissed || dismissed.has(f.id);
          ins.run(f.id, file, f.sentenceId, scope, JSON.stringify({ ...f, dismissed: d }), d ? 1 : 0);
        }
      });
    },
    lint(file) {
      const dismissed = dismissedSet();
      const out: LintFlag[] = [];
      for (const r of st('SELECT json, dismissed FROM lint WHERE file = ?').all(file) as Array<{ json: string; dismissed: number }>) {
        const f = parseFlag(r.json, log);
        if (f) out.push({ ...f, dismissed: f.dismissed || Number(r.dismissed) === 1 || dismissed.has(f.id) });
      }
      return out;
    },
    lintByScope(file) {
      const dismissed = dismissedSet();
      const out = { sentences: [] as LintFlag[], document: [] as LintFlag[] };
      for (const r of st('SELECT json, dismissed, scope FROM lint WHERE file = ?').all(file) as Array<{ json: string; dismissed: number; scope: string }>) {
        const f = parseFlag(r.json, log);
        if (f) (r.scope === 'document' ? out.document : out.sentences).push({ ...f, dismissed: f.dismissed || Number(r.dismissed) === 1 || dismissed.has(f.id) });
      }
      return out;
    },
    dismissLint(id) {
      transaction(() => {
        st('INSERT OR IGNORE INTO lint_dismissed(id) VALUES (?)').run(id);
        const r = st('SELECT json FROM lint WHERE id = ?').get(id) as { json: string } | undefined;
        if (r) {
          const f = parseFlag(r.json, log);
          st('UPDATE lint SET dismissed = 1, json = ? WHERE id = ?').run(JSON.stringify(f ? { ...f, dismissed: true } : JSON.parse(r.json)), id);
        }
      });
    },
    kvGet(key) {
      const r = st('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
      return r ? String(r.value) : undefined;
    },
    kvSet(key, value) {
      st('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    transaction,
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      try {
        db.close();
      } catch (e) {
        log?.debug('db: close failed', String(e));
      }
    },
  };
  return api;
}
