// Каталог только для узбекского рынка: поиск и удаление остальных каналов
const db = require('./db');
const config = require('./config');
const { isUzbekMarket } = require('./classify');

function nonUzbek() {
  return db.all(`SELECT c.*, cat.name AS category_name FROM channels c LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.status IN ('approved', 'pending') ORDER BY c.subscribers DESC`)
    .filter((c) => (c.is_uz === null ? !isUzbekMarket(c).ok : c.is_uz === 0));
}

function removeChannels(items) {
  db.tx(() => {
    for (const c of items) {
      db.run('DELETE FROM channels WHERE id = ?', c.id);
      // Чтобы автопоиск не добавил канал снова
      db.run(`INSERT INTO import_queue (username, source, status, error, processed_at) VALUES (?, 'discovery', 'skipped', 'удалён: не для узбекского рынка', datetime('now'))
              ON CONFLICT(username) DO UPDATE SET status = 'skipped', error = excluded.error, processed_at = excluded.processed_at`, c.username);
    }
  });
  return items.length;
}

// При запуске: убрать неузбекские каналы из стартового списка и автопоиска. Каналы, добавленные людьми, остаются для модератора.
function cleanupOnStart() {
  const removed = removeChannels(nonUzbek().filter((c) => !c.added_by));
  // Мелкие каналы из стартового списка, попавшие до введения порога подписчиков
  const small = db.all(`SELECT c.id, c.username FROM channels c JOIN import_queue q ON q.username = c.username
    WHERE q.source = 'seed' AND c.added_by IS NULL AND c.type != 'bot' AND c.subscribers < ?`, config.discoveryMinSubscribers);
  for (const c of small) {
    db.run('DELETE FROM channels WHERE id = ?', c.id);
    db.run(`UPDATE import_queue SET status = 'skipped', error = ? WHERE username = ?`, `меньше ${config.discoveryMinSubscribers} подписчиков`, c.username);
  }
  if (small.length) console.log(`[region] удалено мелких каналов из стартового списка: ${small.length}`);
  if (removed) console.log(`[region] удалено каналов не для Узбекистана: ${removed}`);
}

module.exports = { nonUzbek, removeChannels, cleanupOnStart };
