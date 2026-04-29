const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'birthday-buddy.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    birthday TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sent_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    message_body TEXT,
    error TEXT,
    UNIQUE(contact_id, year)
  );
`);

// Migrate existing sent_log table if columns are missing
try {
  db.exec(`ALTER TABLE sent_log ADD COLUMN message_body TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE sent_log ADD COLUMN error TEXT`);
} catch {}

module.exports = db;
