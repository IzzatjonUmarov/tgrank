// Очередь импорта: массовое добавление списком, стартовый список и автопоиск.
// Обрабатывает по одному каналу за раз через общую очередь запросов к t.me.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const config = require('./config');
const { parseUsername, fetchChannelInfo, fetchPosts } = require('./telegram');
const { recordStats } = require('./channels');
const { guessCategoryId, guessLanguage, isUzbekMarket } = require('./classify');
const { applyPage } = require('./sync');
const { crawlStep } = require('./crawler');

let stopped = false;

function enqueue(lines, { source = 'admin', categoryId = null, approve = true, regionCheck = true } = {}) {
  let added = 0, skipped = 0;
  const seen = new Set();
  for (const line of lines) {
    const username = parseUsername(line);
    if (!username || seen.has(username.toLowerCase())) { skipped++; continue; }
    seen.add(username.toLowerCase());
    if (db.get('SELECT 1 FROM channels WHERE username = ?', username)) { skipped++; continue; }
    // Повторный импорт вручную возвращает в очередь ранее отклонённые автопоиском
    const r = db.run(`INSERT INTO import_queue (username, source, category_id, approve, region_check) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET status = 'queued', source = excluded.source, category_id = excluded.category_id,
        approve = excluded.approve, region_check = excluded.region_check, error = NULL, attempts = 0
      WHERE import_queue.status != 'queued' AND excluded.source != 'seed'`,
      username, source, categoryId, approve ? 1 : 0, regionCheck ? 1 : 0);
    if (r.changes) added++; else skipped++;
  }
  return { added, skipped };
}

function starterList() {
  const file = path.join(__dirname, 'starter-channels.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function enqueueStarterList() {
  const lines = starterList();
  // Заявки из прежних версий стартового списка больше не нужны
  const keep = new Set(lines.map((l) => l.toLowerCase()));
  const old = db.all(`SELECT username FROM import_queue WHERE status = 'queued' AND source = 'seed'`).filter((r) => !keep.has(r.username.toLowerCase()));
  for (const r of old) db.run(`UPDATE import_queue SET status = 'skipped', error = 'убран из стартового списка' WHERE username = ?`, r.username);
  const r = enqueue(lines, { source: 'seed' });
  if (r.added || old.length) console.log(`[import] стартовый список: в очереди ${r.added}, снято старых заявок: ${old.length}`);
}

async function processOne() {
  // Ручной импорт и стартовый список идут раньше автопоиска
  const item = db.get(`SELECT * FROM import_queue WHERE status = 'queued'
    ORDER BY CASE source WHEN 'admin' THEN 0 WHEN 'seed' THEN 1 ELSE 2 END, mentions DESC, added_at LIMIT 1`);
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
  if (!info) {
    // Telegram иногда отдаёт урезанную страницу — даём каналу второй шанс позже
    if (item.attempts < 1) db.run(`UPDATE import_queue SET attempts = attempts + 1, added_at = datetime('now'), error = 'не найден, повтор позже' WHERE username = ?`, item.username);
    else finish('failed', 'не найден в Telegram');
    return true;
  }
  if (info.type === 'user') { finish('skipped', 'личный аккаунт'); return true; }
  // Порог подписчиков для автопоиска и стартового списка: отсекает мелкие «двойники» известных каналов
  if (item.source !== 'admin' && info.type !== 'bot' && info.subscribers < config.discoveryMinSubscribers) {
    finish('skipped', `меньше ${config.discoveryMinSubscribers} подписчиков`); return true;
  }

  // Посты загружаем один раз: по ним проверяем регион, считаем охваты и ищем новые каналы
  const page = info.type === 'channel' ? await fetchPosts(info.username).catch(() => null) : null;
  // Второй адрес уже известного канала — не добавляем отдельной карточкой
  if (page?.canonical && page.canonical.toLowerCase() !== info.username.toLowerCase()) {
    if (db.get('SELECT 1 FROM channels WHERE username = ?', page.canonical)) { finish('skipped', `дубль @${page.canonical}`); return true; }
    info.username = page.canonical;
  }
  const uz = isUzbekMarket(info, page?.text);
  if (config.region === 'uz' && item.region_check && !uz.ok) { finish('skipped', 'не для узбекского рынка'); return true; }

  insertChannel(info, page, { approved: !!item.approve, categoryId: item.category_id, uz: uz.ok });
  finish('done');
  return true;
}

// Добавляет канал в каталог по уже загруженным профилю и постам (импорт, автопоиск, бот)
function insertChannel(info, page, { approved = true, categoryId = null, uz = true } = {}) {
  const status = approved ? 'approved' : 'pending';
  const { lastInsertRowid } = db.run(`INSERT INTO channels (username, type, title, description, avatar_url, category_id, language, subscribers, tg_verified, status, is_uz, last_checked_at, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ${status === 'approved' ? "datetime('now')" : 'NULL'})`,
    info.username, info.type, info.title, info.description, info.avatar_url,
    categoryId || guessCategoryId(info), guessLanguage(info), info.subscribers, info.tg_verified, status, uz ? 1 : 0);
  const id = Number(lastInsertRowid);
  recordStats(id, info.subscribers);
  applyPage(db.get('SELECT * FROM channels WHERE id = ?', id), info, page);
  return id;
}

async function runWorker() {
  while (!stopped) {
    let worked = false;
    // Очередь пуста — паук листает историю каналов и находит новых кандидатов
    try { worked = (await processOne()) || (await crawlStep()); } catch (e) { console.error('[import]', e.message); }
    await new Promise((r) => setTimeout(r, worked ? 200 : 15_000));
  }
}

function queueStats() {
  return Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM import_queue GROUP BY status').map((r) => [r.status, r.n]));
}

module.exports = { insertChannel, enqueue, enqueueStarterList, runWorker, processOne, queueStats, stop: () => { stopped = true; } };
