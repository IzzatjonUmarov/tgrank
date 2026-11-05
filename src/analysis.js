// Аналитика канала: охваты, ERR, вовлечённость, частота постов и оценка риска накрутки.
// Оценка эвристическая: это сигнал для пользователя и модератора, а не доказательство.
const db = require('./db');
const { fill } = require('./i18n');

const DAY = 86400_000;
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const fmt = (n) => Math.round(n).toLocaleString('ru-RU');

function savePosts(channelId, posts) {
  db.tx(() => {
    for (const p of posts) {
      db.run(`INSERT INTO posts (channel_id, post_id, date, views, reactions, forwarded_from, has_media) VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(channel_id, post_id) DO UPDATE SET views = MAX(views, excluded.views), reactions = excluded.reactions, updated_at = datetime('now')`,
        channelId, p.id, p.date, p.views, p.reactions, p.forwarded_from, p.has_media);
    }
    // Храним только последние 200 постов канала
    db.run(`DELETE FROM posts WHERE channel_id = ? AND post_id NOT IN (SELECT post_id FROM posts WHERE channel_id = ? ORDER BY post_id DESC LIMIT 200)`, channelId, channelId);
  });
}

// Посты старше суток: их просмотры уже почти не растут, по ним честно считать охват
function maturePosts(channelId) {
  const all = db.all(`SELECT * FROM posts WHERE channel_id = ? ORDER BY post_id DESC LIMIT 60`, channelId);
  const mature = all.filter((p) => Date.now() - Date.parse(p.date) >= DAY);
  return { all, mature: (mature.length >= 3 ? mature : all).slice(0, 30) };
}

// Ежедневные изменения подписчиков с поправкой на пропущенные дни
function dailyDeltas(history) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const days = Math.max(1, Math.round((Date.parse(history[i].date) - Date.parse(history[i - 1].date)) / DAY));
    out.push({ date: history[i].date, delta: (history[i].subscribers - history[i - 1].subscribers) / days, base: history[i - 1].subscribers });
  }
  return out;
}

function detectFraud(channel, history, posts, reachHistory) {
  const reasons = [];
  let score = 0;
  // Причина хранится как шаблон + параметры: на сайте она переводится на язык читателя
  const add = (points, tpl, params = {}) => { score += points; reasons.push({ points, tpl, params, text: fill(tpl, params) }); };
  const subs = channel.subscribers;

  // 1. Резкие скачки подписчиков на фоне обычного роста
  const deltas = dailyDeltas(history.slice(-60));
  if (deltas.length >= 3) {
    const typical = Math.max(median(deltas.map((d) => Math.abs(d.delta))), subs * 0.001, 20);
    const spikes = deltas.filter((d) => d.delta > 500 && d.delta > d.base * 0.03 && d.delta > typical * 6);
    if (spikes.length) {
      const top = spikes.reduce((a, b) => (b.delta > a.delta ? b : a));
      add(Math.min(45, 30 + (spikes.length - 1) * 8),
        spikes.length > 1
          ? 'Резкий прирост +{delta} подписчиков за сутки ({date}) при обычном изменении около ±{typical} в день; таких скачков: {count}'
          : 'Резкий прирост +{delta} подписчиков за сутки ({date}) при обычном изменении около ±{typical} в день',
        { delta: fmt(top.delta), date: top.date, typical: fmt(typical), count: spikes.length });

      // 2. Отписка после скачка — боты списываются Telegram или «отваливаются»
      const idx = deltas.indexOf(top);
      const after = deltas.slice(idx + 1, idx + 8).reduce((s, d) => s + Math.min(0, d.delta), 0);
      if (-after > top.delta * 0.3) add(20, 'После скачка за неделю ушло {n} подписчиков — так часто ведут себя накрученные аудитории', { n: fmt(-after) });
    }
  }

  // 3–5. Охваты постов (только у каналов с веб-превью)
  if (posts.length >= 5 && subs >= 1000) {
    const views = posts.map((p) => p.views);
    const reach = mean(views);
    const err = (reach / subs) * 100;
    if (subs >= 3000 && err < 2) add(35, 'Охват поста {err}% от подписчиков — очень мало (обычно 10–40%): большая часть аудитории не читает канал', { err: err.toFixed(1) });
    else if (subs >= 3000 && err < 5) add(20, 'Охват поста {err}% от подписчиков — ниже нормы (обычно 10–40%)', { err: err.toFixed(1) });
    if (err > 150) add(20, 'Просмотров в среднем больше, чем подписчиков ({err}%) — возможна накрутка просмотров', { err: err.toFixed(0) });

    if (posts.length >= 8) {
      const cv = Math.sqrt(mean(views.map((v) => (v - reach) ** 2))) / (reach || 1);
      if (cv < 0.08) add(25, 'Просмотры постов почти одинаковые (разброс {cv}%) — у живой аудитории разброс обычно 20% и больше', { cv: (cv * 100).toFixed(0) });
    }

    const reactions = posts.reduce((s, p) => s + p.reactions, 0);
    const totalViews = views.reduce((s, v) => s + v, 0) || 1;
    if (reactions / totalViews > 0.15 && reactions > 200) add(10, 'Аномально много реакций: {pct}% от просмотров (обычно 1–5%)', { pct: (reactions / totalViews * 100).toFixed(0) });
  }

  // 6. Подписчики растут, а охват — нет
  if (reachHistory.length >= 2) {
    const first = reachHistory[0], last = reachHistory[reachHistory.length - 1];
    const span = (Date.parse(last.date) - Date.parse(first.date)) / DAY;
    if (span >= 14 && first.avg_reach > 0 && first.subscribers > 0) {
      const subsGrowth = last.subscribers / first.subscribers - 1;
      const reachGrowth = last.avg_reach / first.avg_reach - 1;
      if (subsGrowth > 0.3 && reachGrowth < 0.05) add(20, 'За {days} дн. подписчиков стало больше на {pct}%, а охват не вырос', { days: Math.round(span), pct: (subsGrowth * 100).toFixed(0) });
    }
  }

  return { score: Math.min(100, score), reasons };
}

function analyze(channelId) {
  const channel = db.get('SELECT * FROM channels WHERE id = ?', channelId);
  if (!channel) return null;
  const history = db.all(`SELECT date, subscribers FROM stats WHERE channel_id = ? ORDER BY date`, channelId);
  const { all, mature } = maturePosts(channelId);

  let avgReach = null, err = null, postsPerDay = null, engagement = null;
  if (mature.length) {
    avgReach = Math.round(mean(mature.map((p) => p.views)));
    err = channel.subscribers ? Math.round((avgReach / channel.subscribers) * 1000) / 10 : null;
    const views = mature.reduce((s, p) => s + p.views, 0);
    engagement = views ? Math.round((mature.reduce((s, p) => s + p.reactions, 0) / views) * 1000) / 10 : 0;
  }
  if (all.length >= 2) {
    const span = (Date.parse(all[0].date) - Date.parse(all[all.length - 1].date)) / DAY;
    postsPerDay = Math.round((all.length / Math.max(span, 1)) * 10) / 10;
  }

  if (avgReach !== null) {
    db.run(`UPDATE stats SET avg_reach = ?, err = ? WHERE channel_id = ? AND date = (SELECT MAX(date) FROM stats WHERE channel_id = ?)`,
      avgReach, err, channelId, channelId);
  }
  const reachHistory = db.all(`SELECT date, subscribers, avg_reach FROM stats WHERE channel_id = ? AND avg_reach IS NOT NULL AND date >= date('now','-30 day') ORDER BY date`, channelId);
  const fraud = detectFraud(channel, history, mature, reachHistory);

  db.run(`UPDATE channels SET avg_reach = ?, err = ?, posts_per_day = ?, engagement = ?, fraud_score = ?, fraud_reasons = ?, analyzed_at = datetime('now') WHERE id = ?`,
    avgReach, err, postsPerDay, engagement, fraud.score, JSON.stringify(fraud.reasons), channelId);
  return { avgReach, err, postsPerDay, engagement, ...fraud };
}

function fraudLevel(score) {
  if (score >= 50) return { key: 'high', label: 'Высокое подозрение на накрутку' };
  if (score >= 25) return { key: 'medium', label: 'Возможна накрутка' };
  return { key: 'ok', label: 'Признаков накрутки не найдено' };
}

module.exports = { savePosts, analyze, detectFraud, fraudLevel, dailyDeltas };
