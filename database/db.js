'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { makeLogger } = require('../utils/logger');

const log = makeLogger('Database');

/**
 * Additive migrations only. Never drop or recreate a table here: the database
 * file lives on a Railway persistent volume and survives every deploy.
 */
const MIGRATIONS = [
  {
    id: '001_core_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key         TEXT PRIMARY KEY,
          value       TEXT,
          updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS campaigns (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          text          TEXT NOT NULL DEFAULT '',
          media_type    TEXT,
          media_file_id TEXT,
          button_text   TEXT,
          button_url    TEXT,
          parse_mode    TEXT NOT NULL DEFAULT 'HTML',
          language      TEXT NOT NULL DEFAULT 'mixed',
          enabled       INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS groups (
          chat_id           INTEGER PRIMARY KEY,
          title             TEXT NOT NULL DEFAULT '',
          type              TEXT NOT NULL DEFAULT 'group',
          username          TEXT,
          registered_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          registered_by     INTEGER,
          enabled           INTEGER NOT NULL DEFAULT 1,
          interval_minutes  INTEGER,
          campaign_id       INTEGER,
          rotation_enabled  INTEGER NOT NULL DEFAULT 0,
          last_campaign_id  INTEGER,
          last_send_at      TEXT,
          next_send_at      TEXT,
          last_message_id   INTEGER,
          delete_previous   INTEGER NOT NULL DEFAULT 0,
          quiet_enabled     INTEGER NOT NULL DEFAULT 0,
          quiet_start       TEXT NOT NULL DEFAULT '00:00',
          quiet_end         TEXT NOT NULL DEFAULT '08:00',
          can_send          INTEGER NOT NULL DEFAULT 1,
          delivery_problem  INTEGER NOT NULL DEFAULT 0,
          last_error        TEXT,
          last_error_at     TEXT
        );

        CREATE TABLE IF NOT EXISTS group_campaigns (
          chat_id     INTEGER NOT NULL,
          campaign_id INTEGER NOT NULL,
          position    INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (chat_id, campaign_id)
        );

        CREATE TABLE IF NOT EXISTS ad_deliveries (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          idempotency_key     TEXT NOT NULL UNIQUE,
          campaign_id         INTEGER,
          chat_id             INTEGER NOT NULL,
          scheduled_for       TEXT,
          sent_at             TEXT,
          telegram_message_id INTEGER,
          status              TEXT NOT NULL DEFAULT 'pending',
          error_code          TEXT,
          error_message       TEXT,
          trigger_type        TEXT NOT NULL DEFAULT 'scheduled',
          created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          admin_id   INTEGER,
          action     TEXT NOT NULL,
          target     TEXT,
          details    TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_groups_due ON groups (enabled, next_send_at);
        CREATE INDEX IF NOT EXISTS idx_deliveries_chat ON ad_deliveries (chat_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_deliveries_status ON ad_deliveries (status, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
      `);
    },
  },
  {
    // Adds MTProto user-account delivery alongside the original bot delivery.
    // Purely additive: every existing row keeps working, defaulting to the
    // bot sender it was registered with.
    id: '002_mtproto_user_sender',
    up: (db) => {
      const groupColumns = new Set(db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name));
      const addGroupColumn = (name, definition) => {
        if (!groupColumns.has(name)) db.exec(`ALTER TABLE groups ADD COLUMN ${name} ${definition};`);
      };

      // Which client posts to this group: 'bot' (original) or 'user' (MTProto).
      addGroupColumn('sender_kind', "TEXT NOT NULL DEFAULT 'bot'");
      // MTProto peer identity. access_hash is a signed 64-bit value that does
      // not fit a JS number, so it is stored as TEXT to avoid precision loss.
      addGroupColumn('peer_type', 'TEXT');
      addGroupColumn('access_hash', 'TEXT');
      // Last time the user account confirmed it can still reach this peer.
      addGroupColumn('peer_checked_at', 'TEXT');

      const campaignColumns = new Set(db.prepare('PRAGMA table_info(campaigns)').all().map((c) => c.name));
      if (!campaignColumns.has('media_local_path')) {
        // A Bot API file_id cannot be used by an MTProto user account, so the
        // file is cached on the persistent volume and uploaded from there.
        db.exec('ALTER TABLE campaigns ADD COLUMN media_local_path TEXT;');
      }

      db.exec('CREATE INDEX IF NOT EXISTS idx_groups_sender ON groups (sender_kind, enabled);');
    },
  },
];

/**
 * Railway mounts a persistent volume at /data. Storage counts as persistent
 * when the database directory lives outside the deployed application folder
 * and is writable.
 */
function detectPersistence(dbPath) {
  const dir = path.dirname(path.resolve(dbPath));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (_) {
    return false;
  }
  const appDir = path.resolve(process.cwd());
  return !dir.startsWith(appDir);
}

function applyMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);
  const applied = new Set(db.prepare('SELECT id FROM migrations').all().map((r) => r.id));
  const fresh = [];
  const insert = db.prepare('INSERT INTO migrations (id) VALUES (?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      migration.up(db);
      insert.run(migration.id);
    })();
    fresh.push(migration.id);
  }
  return fresh;
}

/**
 * Opens (never deletes) the database, applies pending migrations and returns
 * the connection plus diagnostics for startup logging.
 */
function openDatabase({ dbPath, verbose = false } = {}) {
  const resolved = path.resolve(dbPath);
  const persistent = detectPersistence(resolved);
  const existed = fs.existsSync(resolved);

  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const applied = applyMigrations(db);

  if (verbose) {
    log.info(`path: ${resolved}`);
    log.info(`persistent: ${persistent ? 'YES' : 'NO'}`);
    log.info(`existing file: ${existed ? 'YES' : 'NO (created)'}`);
    if (applied.length) log.info(`migrations applied: ${applied.join(', ')}`);
  }

  return { db, path: resolved, persistent, existed, appliedMigrations: applied };
}

function integrityCheck(db) {
  const result = db.pragma('integrity_check', { simple: true });
  return { ok: result === 'ok', result };
}

function closeDatabase(db) {
  if (!db || !db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (_) {
    // Checkpointing is best-effort; closing still flushes.
  }
  db.close();
}

module.exports = { openDatabase, closeDatabase, integrityCheck, detectPersistence, applyMigrations, MIGRATIONS };
