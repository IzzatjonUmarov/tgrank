// Полная синхронизация одного канала: профиль, посты, аналитика и поиск новых каналов в постах
const db = require('./db');
const config = require('./config');
const { fetchChannelInfo, fetchPosts } = require('./telegram');
const { applyInfo } = require('./channels');
const { savePosts, analyze } = require('./analysis');

async function syncChannel(channel) {
  const info = await fetchChannelInfo(channel.username);
  if (!info) return { ok: false, error: 'канал не найден в Telegram' };
  applyInfo(channel.id, info);

  if (info.type === 'channel') await syncPosts(channel.id, channel.username);
  return { ok: true, info, analysis: analyze(channel.id) };
}

async function syncPosts(channelId, username) {
  const page = await fetchPosts(username).catch(() => null);
  if (!page) return;
  savePosts(channelId, page.posts);
  if (config.discovery) enqueueDiscovered(page.mentions);
}

// Упомянутые и репостнутые каналы попадают в очередь импорта
function enqueueDiscovered(usernames) {
  if (!usernames.length) return;
  const queued = db.get(`SELECT COUNT(*) AS n FROM import_queue WHERE status = 'queued'`).n;
  if (queued >= config.discoveryQueueLimit) return;
  for (const u of usernames.slice(0, 30)) {
    if (db.get('SELECT 1 FROM channels WHERE username = ?', u)) continue;
    db.run(`INSERT OR IGNORE INTO import_queue (username, source, approve) VALUES (?, 'discovery', ?)`, u, config.autoApproveDiscovered ? 1 : 0);
  }
}

module.exports = { syncChannel, syncPosts };
