// Дубли каналов: у одного Telegram-канала может быть несколько адресов (@durov, @snow, @paul).
// Основной адрес узнаём по подписям постов в веб-просмотре; уже попавшие в каталог дубли объединяем.
const db = require('./db');

// Какую карточку оставить: с подтверждённым владельцем, потом основной адрес, потом с более длинной историей
function pickKeeper(items, canonical = null) {
  const score = (c) => [
    c.owner_id ? 1 : 0,
    canonical && c.username.toLowerCase() === canonical.toLowerCase() ? 1 : 0,
    db.get('SELECT COUNT(*) AS n FROM stats WHERE channel_id = ?', c.id).n,
    c.subscribers,
    -c.id,
  ];
  return [...items].sort((a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  })[0];
}

// Переносит всё, что связано с дублем, на основную карточку и удаляет дубль
function merge(keep, dup) {
  if (keep.id === dup.id) return false;
  // Два разных подтверждённых владельца — решает модератор, автоматически не объединяем
  if (keep.owner_id && dup.owner_id && keep.owner_id !== dup.owner_id) return false;
  db.tx(() => {
    for (const t of ['votes', 'favorites', 'reviews']) {
      db.run(`UPDATE OR IGNORE ${t} SET channel_id = ? WHERE channel_id = ?`, keep.id, dup.id);
      db.run(`DELETE FROM ${t} WHERE channel_id = ?`, dup.id);
    }
    db.run('UPDATE orders SET channel_id = ? WHERE channel_id = ?', keep.id, dup.id);
    db.run('UPDATE conversations SET channel_id = ? WHERE channel_id = ?', keep.id, dup.id);
    db.run('UPDATE reports SET channel_id = ? WHERE channel_id = ?', keep.id, dup.id);
    // Владелец и прайс переходят, если у основной карточки их нет
    if (!keep.owner_id && dup.owner_id) {
      db.run(`UPDATE channels SET owner_id = ?, ads_enabled = ?, ad_currency = ?, ad_prices = ?, ad_min_price_uzs = ?, ad_contact = ?, ad_note = ? WHERE id = ?`,
        dup.owner_id, dup.ads_enabled, dup.ad_currency, dup.ad_prices, dup.ad_min_price_uzs, dup.ad_contact, dup.ad_note, keep.id);
    }
    db.run('UPDATE channels SET votes = votes + ?, views = views + ? WHERE id = ?', dup.votes, dup.views, keep.id);
    db.run('DELETE FROM channels WHERE id = ?', dup.id);
    // Чтобы автопоиск не добавил второй адрес снова
    db.run(`INSERT INTO import_queue (username, source, status, error, processed_at) VALUES (?, 'discovery', 'skipped', ?, datetime('now'))
            ON CONFLICT(username) DO UPDATE SET status = 'skipped', error = excluded.error, processed_at = excluded.processed_at`,
      dup.username, `дубль @${keep.username}`);
  });
  require('./channels').refreshRating(keep.id);
  return true;
}

// Сайт узнал основной адрес канала: объединяем или переименовываем карточку
function resolveAlias(channel, canonical) {
  if (!canonical || canonical.toLowerCase() === channel.username.toLowerCase() || channel.is_private) return channel;
  const main = db.get('SELECT * FROM channels WHERE username = ?', canonical);
  if (main) {
    const keep = pickKeeper([main, channel], canonical);
    const dup = keep.id === main.id ? channel : main;
    if (merge(keep, dup)) {
      // Основная карточка получает основной адрес
      if (keep.username.toLowerCase() !== canonical.toLowerCase()) db.run('UPDATE channels SET username = ? WHERE id = ?', canonical, keep.id);
      console.log(`[dedupe] @${dup.username} → @${canonical}`);
    }
    return db.get('SELECT * FROM channels WHERE id = ?', keep.id);
  }
  db.run('UPDATE channels SET username = ? WHERE id = ?', canonical, channel.id);
  db.run(`INSERT INTO import_queue (username, source, status, error, processed_at) VALUES (?, 'discovery', 'skipped', ?, datetime('now'))
          ON CONFLICT(username) DO UPDATE SET status = 'skipped', error = excluded.error`, channel.username, `второй адрес @${canonical}`);
  return db.get('SELECT * FROM channels WHERE id = ?', channel.id);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Дубли среди каналов и групп: то же название и описание, подписчиков почти столько же.
// Боты с одинаковым названием — разные боты, их не трогаем.
function findDuplicates() {
  const rows = db.all(`SELECT * FROM channels WHERE status IN ('approved', 'pending') AND type IN ('channel', 'group') AND is_private = 0 AND subscribers > 0`);
  const groups = {};
  for (const c of rows) (groups[`${c.type}|${norm(c.title)}|${norm(c.description).slice(0, 300)}`] ??= []).push(c);
  const result = [];
  for (const list of Object.values(groups)) {
    if (list.length < 2 || !norm(list[0].title)) continue;
    list.sort((a, b) => b.subscribers - a.subscribers);
    const used = new Set();
    for (const a of list) {
      if (used.has(a.id)) continue;
      const cluster = list.filter((b) => !used.has(b.id) && Math.abs(a.subscribers - b.subscribers) <= Math.max(a.subscribers, b.subscribers) * 0.02);
      cluster.forEach((c) => used.add(c.id));
      if (cluster.length > 1) result.push(cluster);
    }
  }
  return result;
}

function mergeAll() {
  let merged = 0;
  for (const cluster of findDuplicates()) {
    const keep = pickKeeper(cluster);
    for (const dup of cluster) if (dup.id !== keep.id && merge(keep, dup)) merged++;
  }
  if (merged) console.log(`[dedupe] объединено дублей: ${merged}`);
  return merged;
}

module.exports = { merge, pickKeeper, resolveAlias, findDuplicates, mergeAll };
