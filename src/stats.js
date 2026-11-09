// Периодическое обновление подписчиков, постов и аналитики всех одобренных каналов.
// Запускается автоматически из server.js и вручную: npm run update-stats
const db = require('./db');
const { syncChannel } = require('./sync');

let running = false;

async function updateAll({ log = console.log } = {}) {
  if (running) return;
  running = true;
  let ok = 0, failed = 0;
  try {
    const rows = db.all(`SELECT id, username FROM channels WHERE status = 'approved'
                         ORDER BY last_checked_at IS NOT NULL, last_checked_at`);
    for (const row of rows) {
      try {
        const r = await syncChannel(row);
        if (r.ok) ok++; else failed++;
      } catch { failed++; }
    }
  } finally {
    running = false;
  }
  log(`[stats] обновлено: ${ok}, ошибок: ${failed}`);
  require('./dedupe').mergeAll();
}

module.exports = { updateAll, isRunning: () => running };

if (require.main === module) updateAll().then(() => process.exit(0));
