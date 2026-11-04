// «Паук»: листает историю постов каналов каталога вглубь и собирает упомянутые
// и репостнутые каналы в очередь импорта. Работает, когда очередь импорта пуста.
const db = require('./db');
const config = require('./config');
const { fetchPosts } = require('./telegram');
const { enqueueDiscovered } = require('./sync');

async function crawlStep() {
  if (!config.discovery) return false;
  // Сначала крупные каналы: их чаще читают и чаще упоминают другие узбекские каналы
  const c = db.get(`SELECT id, username, crawl_before, crawl_pages FROM channels
    WHERE status = 'approved' AND type = 'channel' AND is_private = 0 AND crawl_done = 0
    ORDER BY crawled_at IS NOT NULL, crawled_at, subscribers DESC LIMIT 1`);
  if (!c) return false;

  const page = await fetchPosts(c.username, c.crawl_before).catch(() => null);
  const ids = page ? page.posts.map((p) => p.id) : [];
  const oldest = ids.length ? Math.min(...ids) : null;
  const done = !page || !oldest || oldest <= 1 || oldest === c.crawl_before || c.crawl_pages + 1 >= config.crawlMaxPages;
  if (page) enqueueDiscovered(page.mentions);
  db.run(`UPDATE channels SET crawl_before = ?, crawl_pages = crawl_pages + 1, crawl_done = ?, crawled_at = datetime('now') WHERE id = ?`,
    oldest ?? c.crawl_before, done ? 1 : 0, c.id);
  return true;
}

function crawlStats() {
  return db.get(`SELECT COUNT(*) AS total, SUM(crawl_done) AS done, COALESCE(SUM(crawl_pages), 0) AS pages
    FROM channels WHERE status = 'approved' AND type = 'channel' AND is_private = 0`);
}

module.exports = { crawlStep, crawlStats };
