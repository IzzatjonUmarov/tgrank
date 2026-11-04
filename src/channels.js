const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');

const today = () => new Date().toISOString().slice(0, 10);

// Число подписчиков N дней назад (ближайшая запись не позже этой даты)
const pastSubs = (days) =>
  `(SELECT s.subscribers FROM stats s WHERE s.channel_id = c.id AND s.date <= date('now','-${Number(days)} day') ORDER BY s.date DESC LIMIT 1)`;

const BASE_SELECT = `
  SELECT c.*, cat.name AS category_name, cat.slug AS category_slug, cat.icon AS category_icon,
    c.subscribers - COALESCE(${pastSubs(1)}, c.subscribers) AS growth_day,
    c.subscribers - COALESCE(${pastSubs(7)}, c.subscribers) AS growth_week,
    c.subscribers - COALESCE(${pastSubs(30)}, c.subscribers) AS growth_month,
    (c.boost_until IS NOT NULL AND c.boost_until > datetime('now')) AS boosted
  FROM channels c LEFT JOIN categories cat ON cat.id = c.category_id`;

const SORTS = {
  popular: 'boosted DESC, c.featured DESC, c.subscribers DESC',
  subscribers: 'c.subscribers DESC',
  growth_day: 'growth_day DESC, c.subscribers DESC',
  growth_week: 'growth_week DESC, c.subscribers DESC',
  growth_month: 'growth_month DESC, c.subscribers DESC',
  votes: 'c.votes DESC, c.subscribers DESC',
  rating: '(c.rating_avg * c.rating_count + 3.5 * 3) / (c.rating_count + 3) DESC, c.subscribers DESC',
  new: 'c.approved_at DESC, c.id DESC',
  views: 'c.views DESC',
};

function list({ q, type, category, language, minSubs, maxSubs, verified, sort = 'popular', page = 1, perPage = config.perPage, status = 'approved' } = {}) {
  const where = ['c.status = ?'];
  const params = [status];
  if (q) {
    where.push('(c.title LIKE ? OR c.username LIKE ? OR c.description LIKE ? OR c.tags LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (type) { where.push('c.type = ?'); params.push(type); }
  if (category) { where.push('cat.slug = ?'); params.push(category); }
  if (language) { where.push('c.language = ?'); params.push(language); }
  if (minSubs) { where.push('c.subscribers >= ?'); params.push(Number(minSubs)); }
  if (maxSubs) { where.push('c.subscribers <= ?'); params.push(Number(maxSubs)); }
  if (verified) where.push('c.owner_id IS NOT NULL');

  const whereSql = 'WHERE ' + where.join(' AND ');
  const order = SORTS[sort] || SORTS.popular;
  const total = db.get(`SELECT COUNT(*) AS n FROM channels c LEFT JOIN categories cat ON cat.id = c.category_id ${whereSql}`, ...params).n;
  const offset = (Math.max(1, page) - 1) * perPage;
  const items = db.all(`${BASE_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, perPage, offset);
  return { items, total, page: Number(page), pages: Math.max(1, Math.ceil(total / perPage)) };
}

function byUsername(username) {
  return db.get(`${BASE_SELECT} WHERE c.username = ?`, username);
}
function byId(id) {
  return db.get(`${BASE_SELECT} WHERE c.id = ?`, id);
}

function boosted(limit = 8) {
  return db.all(`${BASE_SELECT} WHERE c.status = 'approved' AND c.boost_until > datetime('now') ORDER BY c.boost_until DESC LIMIT ?`, limit);
}

function rankPosition(channel) {
  return db.get(`SELECT COUNT(*) + 1 AS pos FROM channels WHERE status = 'approved' AND type = ? AND subscribers > ?`, channel.type, channel.subscribers).pos;
}

function history(channelId, days = 90) {
  return db.all(`SELECT date, subscribers FROM stats WHERE channel_id = ? AND date >= date('now', ?) ORDER BY date`, channelId, `-${days} day`);
}

function similar(channel, limit = 6) {
  return db.all(`${BASE_SELECT} WHERE c.status = 'approved' AND c.id != ? AND c.category_id IS ? ORDER BY ABS(c.subscribers - ?) LIMIT ?`,
    channel.id, channel.category_id, channel.subscribers, limit);
}

function recordStats(channelId, subscribers) {
  db.run(`INSERT INTO stats (channel_id, date, subscribers) VALUES (?, ?, ?)
          ON CONFLICT(channel_id, date) DO UPDATE SET subscribers = excluded.subscribers`, channelId, today(), subscribers);
}

function applyInfo(channelId, info) {
  db.run(`UPDATE channels SET title = ?, description = ?, avatar_url = COALESCE(?, avatar_url), subscribers = ?,
            tg_verified = ?, last_checked_at = datetime('now') WHERE id = ?`,
    info.title, info.description, info.avatar_url, info.subscribers, info.tg_verified, channelId);
  recordStats(channelId, info.subscribers);
}

// Код привязан к паре канал+пользователь, поэтому чужой код не подтвердит владение
function verifyCode(channelId, userId) {
  return 'tgrank-' + crypto.createHmac('sha256', config.sessionSecret).update(`${channelId}:${userId}`).digest('hex').slice(0, 10);
}

function refreshRating(channelId) {
  db.run(`UPDATE channels SET rating_avg = COALESCE((SELECT AVG(rating) FROM reviews WHERE channel_id = ?), 0),
            rating_count = (SELECT COUNT(*) FROM reviews WHERE channel_id = ?) WHERE id = ?`, channelId, channelId, channelId);
}

function siteStats() {
  return db.get(`SELECT COUNT(*) AS total,
      SUM(type = 'channel') AS channels, SUM(type = 'group') AS groups, SUM(type = 'bot') AS bots,
      COALESCE(SUM(subscribers), 0) AS audience
    FROM channels WHERE status = 'approved'`);
}

module.exports = { list, byUsername, byId, boosted, rankPosition, history, similar, recordStats, applyInfo, verifyCode, refreshRating, siteStats, SORTS, today };
