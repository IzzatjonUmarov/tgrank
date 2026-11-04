// Очередь импорта: массовое добавление списком, стартовый список и автопоиск.
// Обрабатывает по одному каналу за раз через общую очередь запросов к t.me.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const config = require('./config');
const { parseUsername, fetchChannelInfo } = require('./telegram');
const { recordStats } = require('./channels');
const { guessCategoryId, guessLanguage } = require('./classify');
const { syncPosts } = require('./sync');
const { analyze } = require('./analysis');

let stopped = false;

function enqueue(lines, { source = 'admin', categoryId = null, approve = true } = {}) {
  let added = 0, skipped = 0;
  const seen = new Set();
  for (const line of lines) {
    const username = parseUsername(line);
    if (!username || seen.has(username.toLowerCase())) { skipped++; continue; }
    seen.add(username.toLowerCase());
    if (db.get('SELECT 1 FROM channels WHERE username = ?', username)) { skipped++; continue; }
    // Повторный импорт вручную возвращает в очередь ранее отклонённые автопоиском
    const r = db.run(`INSERT INTO import_queue (username, source, category_id, approve) VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET status = 'queued', source = excluded.source, category_id = excluded.category_id,
        approve = excluded.approve, error = NULL, attempts = 0
      WHERE import_queue.status != 'queued' AND excluded.source != 'seed'`,
      username, source, categoryId, approve ? 1 : 0);
    if (r.changes) added++; else skipped++;
  }
  return { added, skipped };
}

function enqueueStarterList() {
  const file = path.join(__dirname, 'starter-channels.txt');
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const r = enqueue(lines, { source: 'seed' });
  if (r.added) console.log(`[import] стартовый список: в очереди ${r.added}`);
}

async function processOne() {
  // Ручной импорт и стартовый список идут раньше автопоиска
  const item = db.get(`SELECT * FROM import_queue WHERE status = 'queued'
    ORDER BY CASE source WHEN 'admin' THEN 0 WHEN 'seed' THEN 1 ELSE 2 END, added_at LIMIT 1`);
  if (!item) return false;
  const finish = (status, error = null) =>
    db.run(`UPDATE import_queue SET status = ?, error = ?, attempts = attempts + 1, processed_at = datetime('now') WHERE username = ?`, status, error, item.username);

  if (db.get('SELECT 1 FROM channels WHERE username = ?', item.username)) { finish('skipped', 'уже в каталоге'); return true; }
  let info;
  try {
    info = await fetchChannelInfo(item.username);
  } catch (e) {
    if (item.attempts >= 2) finish('failed', e.message);
    else db.run('UPDATE import_queue SET attempts = attempts + 1, error = ? WHERE username = ?', e.message, item.username);
    return true;
  }
  if (!info) { finish('failed', 'не найден в Telegram'); return true; }
  if (info.type === 'user') { finish('skipped', 'личный аккаунт'); return true; }
  if (item.source === 'discovery' && info.type !== 'bot' && info.subscribers < config.discoveryMinSubscribers) {
    finish('skipped', `меньше ${config.discoveryMinSubscribers} подписчиков`); return true;
  }

  const status = item.approve ? 'approved' : 'pending';
  const { lastInsertRowid } = db.run(`INSERT INTO channels (username, type, title, description, avatar_url, category_id, language, subscribers, tg_verified, status, last_checked_at, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ${status === 'approved' ? "datetime('now')" : 'NULL'})`,
    info.username, info.type, info.title, info.description, info.avatar_url,
    item.category_id || guessCategoryId(info), guessLanguage(info), info.subscribers, info.tg_verified, status);
  const id = Number(lastInsertRowid);
  recordStats(id, info.subscribers);
  finish('done');
  if (info.type === 'channel') await syncPosts(id, info.username);
  db.run(`UPDATE channels SET last_checked_at = datetime('now') WHERE id = ?`, id);
  analyze(id);
  return true;
}

async function runWorker() {
  while (!stopped) {
    let worked = false;
    try { worked = await processOne(); } catch (e) { console.error('[import]', e.message); }
    await new Promise((r) => setTimeout(r, worked ? 200 : 15_000));
  }
}

function queueStats() {
  return Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM import_queue GROUP BY status').map((r) => [r.status, r.n]));
}

module.exports = { enqueue, enqueueStarterList, runWorker, processOne, queueStats, stop: () => { stopped = true; } };
