const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  username TEXT NOT NULL,
  password_hash TEXT,
  telegram_id INTEGER UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📁',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL DEFAULT 'channel',
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  language TEXT NOT NULL DEFAULT 'ru',
  tags TEXT NOT NULL DEFAULT '',
  subscribers INTEGER NOT NULL DEFAULT 0,
  tg_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  boost_until TEXT,
  last_boost_at TEXT,
  featured INTEGER NOT NULL DEFAULT 0,
  votes INTEGER NOT NULL DEFAULT 0,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status, subscribers DESC);
CREATE TABLE IF NOT EXISTS stats (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  subscribers INTEGER NOT NULL,
  PRIMARY KEY (channel_id, date)
);
CREATE TABLE IF NOT EXISTS votes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_id, date)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_id, user_id)
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_a, user_b)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  text TEXT NOT NULL,
  order_id INTEGER,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  channel_title TEXT NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  executor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  price INTEGER,
  currency TEXT NOT NULL DEFAULT 'UZS',
  publish_date TEXT,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_users ON orders(executor_id, status);
CREATE TABLE IF NOT EXISTS user_ratings (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 10),
  text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, from_user)
);
CREATE TABLE IF NOT EXISTS admin_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS posts (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  reactions INTEGER NOT NULL DEFAULT 0,
  forwarded_from TEXT,
  has_media INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_posts_date ON posts(channel_id, date DESC);
CREATE TABLE IF NOT EXISTS import_queue (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  source TEXT NOT NULL DEFAULT 'admin',
  category_id INTEGER,
  approve INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON import_queue(status, source, added_at);
`);

// Миграции для баз, созданных до появления аналитики
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('channels', 'avg_reach', 'INTEGER');
addColumn('channels', 'err', 'REAL');
addColumn('channels', 'posts_per_day', 'REAL');
addColumn('channels', 'engagement', 'REAL');
addColumn('channels', 'fraud_score', 'INTEGER NOT NULL DEFAULT 0');
addColumn('channels', 'fraud_reasons', "TEXT NOT NULL DEFAULT '[]'");
addColumn('channels', 'analyzed_at', 'TEXT');
addColumn('channels', 'is_uz', 'INTEGER');
addColumn('channels', 'is_private', 'INTEGER NOT NULL DEFAULT 0');
addColumn('channels', 'invite_link', 'TEXT');
addColumn('import_queue', 'region_check', 'INTEGER NOT NULL DEFAULT 1');
addColumn('import_queue', 'mentions', 'INTEGER NOT NULL DEFAULT 1');
addColumn('channels', 'crawl_before', 'INTEGER');
addColumn('channels', 'crawl_pages', 'INTEGER NOT NULL DEFAULT 0');
addColumn('channels', 'crawl_done', 'INTEGER NOT NULL DEFAULT 0');
addColumn('channels', 'crawled_at', 'TEXT');
addColumn('channels', 'ads_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('channels', 'ad_currency', "TEXT NOT NULL DEFAULT 'UZS'");
addColumn('channels', 'ad_prices', "TEXT NOT NULL DEFAULT '[]'");
addColumn('channels', 'ad_min_price_uzs', 'INTEGER');
addColumn('channels', 'ad_contact', 'TEXT');
addColumn('channels', 'ad_note', 'TEXT');
addColumn('channels', 'ad_updated_at', 'TEXT');
addColumn('users', 'rating_avg', 'REAL NOT NULL DEFAULT 0');
addColumn('users', 'rating_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'orders_done', 'INTEGER NOT NULL DEFAULT 0');
addColumn('users', 'about', "TEXT NOT NULL DEFAULT ''");
addColumn('users', 'tg_username', 'TEXT');
addColumn('users', 'photo_url', 'TEXT');
addColumn('stats', 'avg_reach', 'INTEGER');
addColumn('stats', 'err', 'REAL');

const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

module.exports = {
  db,
  get: (sql, ...p) => prep(sql).get(...p),
  all: (sql, ...p) => prep(sql).all(...p),
  run: (sql, ...p) => prep(sql).run(...p),
  tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  },
};
