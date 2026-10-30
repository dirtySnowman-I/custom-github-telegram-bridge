import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openStore(dataDir) {
  if (!path.isAbsolute(dataDir)) throw new Error('DATA_DIR must be absolute');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const dbPath = path.join(dataDir, 'messages.db');
  const db = new DatabaseSync(dbPath);
  fs.chmodSync(dbPath, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_events (
      event_id TEXT PRIMARY KEY, delivered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      update_id INTEGER PRIMARY KEY,
      message_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT,
      original_name TEXT,
      saved_name TEXT,
      sha256 TEXT,
      size_bytes INTEGER,
      created_at TEXT NOT NULL
    );`);
  const insert = db.prepare(`INSERT OR IGNORE INTO messages
    (update_id, message_id, chat_id, user_id, kind, content, original_name, saved_name, sha256, size_bytes, created_at)
    VALUES (@update_id, @message_id, @chat_id, @user_id, @kind, @content, @original_name, @saved_name, @sha256, @size_bytes, @created_at)`);
  return {
    dataDir,
    getCursor() { return Number(db.prepare("SELECT value FROM settings WHERE key = 'cursor'").get()?.value ?? 0); },
    has(id) { return !!db.prepare('SELECT 1 FROM messages WHERE update_id = ?').get(id); },
    record(row) { insert.run(row); },
    advance(id) {
      const current = this.getCursor();
      if (id > current) db.prepare("INSERT INTO settings(key,value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(id));
    },
    getActiveIssue() { return Number(db.prepare("SELECT value FROM settings WHERE key = 'active_issue'").get()?.value || 0); },
    setActiveIssue(issue) {
      if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('Invalid issue number');
      db.prepare("INSERT INTO settings(key,value) VALUES ('active_issue', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(issue));
    },
    clearActiveIssue() { db.prepare("DELETE FROM settings WHERE key = 'active_issue'").run(); },
    setPendingMention(handle) {
      if (!/^[a-z][a-z0-9-]{1,32}$/.test(handle)) throw new Error('Invalid mention handle');
      db.prepare("INSERT INTO settings(key,value) VALUES ('pending_mention', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(handle);
    },
    getPendingMention() { return db.prepare("SELECT value FROM settings WHERE key='pending_mention'").get()?.value || ''; },
    clearPendingMention() { db.prepare("DELETE FROM settings WHERE key='pending_mention'").run(); },
    getInboxCursor() { return db.prepare("SELECT value FROM settings WHERE key='inbox_cursor'").get()?.value || ''; },
    setInboxCursor(iso) {
      if (!Number.isFinite(Date.parse(iso))) throw new Error('Invalid inbox timestamp');
      db.prepare("INSERT INTO settings(key,value) VALUES ('inbox_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(iso);
    },
    hasInboxEvent(id) { return !!db.prepare("SELECT 1 FROM inbox_events WHERE event_id=?").get(String(id)); },
    markInboxEvent(id) {
      db.prepare("INSERT OR IGNORE INTO inbox_events(event_id,delivered_at) VALUES (?, ?)").run(String(id), new Date().toISOString());
    },
    stats() {
      return { count: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
        cursor: this.getCursor(),
        byKind: db.prepare('SELECT kind, COUNT(*) AS n FROM messages GROUP BY kind ORDER BY kind').all() };
    },
    integrity() { return db.prepare('PRAGMA quick_check').get().quick_check; },
    latest(limit = 5) { return db.prepare('SELECT update_id,kind,original_name,sha256,size_bytes FROM messages ORDER BY update_id DESC LIMIT ?').all(limit); },
    close() { db.close(); },
  };
}
