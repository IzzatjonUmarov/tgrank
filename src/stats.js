// Периодическое обновление подписчиков всех одобренных каналов.
// Запускается автоматически из server.js и вручную: npm run update-stats
const db = require('./db');
const { fetchChannelInfo } = require('./telegram');
const { applyInfo } = require('./channels');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
        const info = await fetchChannelInfo(row.username);
        if (info) { applyInfo(row.id, info); ok++; } else failed++;
      } catch { failed++; }
      await sleep(1500); // бережём t.me от лишней нагрузки
    }
  } finally {
    running = false;
  }
  log(`[stats] обновлено: ${ok}, ошибок: ${failed}`);
}

module.exports = { updateAll };

if (require.main === module) updateAll().then(() => process.exit(0));
