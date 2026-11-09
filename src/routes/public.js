const express = require('express');
const db = require('../db');
const config = require('../config');
const ch = require('../channels');
const crypto = require('node:crypto');
const { parseUsername, parseInvite, fetchChannelInfo, fetchInviteInfo, isChannelAdmin } = require('../telegram');
const { isUzbekMarket } = require('../classify');
const { requireUser } = require('./guards');
const { rateLimit } = require('../security');
const userLimit = (name, max, minutes) => rateLimit(name, { max, windowMs: minutes * 60_000, by: 'user' });
const { TYPES, LANGUAGES } = require('../helpers');
const { fraudLevel, dailyDeltas, analyze } = require('../analysis');
const { syncChannel, syncPosts, fetchProfile } = require('../sync');

const REFRESH_MINUTES = 30;
function canRefresh(channel) {
  if (!channel.last_checked_at) return true;
  return Date.now() - Date.parse(channel.last_checked_at.replace(' ', 'T') + 'Z') >= REFRESH_MINUTES * 60_000;
}

const router = express.Router();

router.get('/', (req, res) => {
  const top = (type, sort = 'subscribers') => ch.list({ type, sort, perPage: 10 }).items;
  res.render('home', {
    title: config.region === 'uz' ? 'Каталог и рейтинг Telegram-каналов Узбекистана' : 'Каталог и рейтинг Telegram-каналов',
    stats: ch.siteStats(),
    boosted: ch.boosted(8),
    topChannels: top('channel'),
    topGroups: top('group'),
    topBots: top('bot'),
    growing: ch.list({ sort: 'growth_week', perPage: 10 }).items,
    newest: ch.list({ sort: 'new', perPage: 8 }).items,
    catCounts: Object.fromEntries(db.all(`SELECT category_id, COUNT(*) AS n FROM channels WHERE status = 'approved' GROUP BY category_id`).map((r) => [r.category_id, r.n])),
  });
});

function renderCatalog(req, res, preset = {}) {
  const f = {
    q: (req.query.q || '').trim().slice(0, 100),
    type: TYPES[req.query.type] ? req.query.type : '',
    category: req.query.category || '',
    language: LANGUAGES[req.query.language] ? req.query.language : '',
    minSubs: req.query.min || '',
    maxSubs: req.query.max || '',
    verified: req.query.verified === '1',
    clean: req.query.clean === '1',
    ads: req.query.ads === '1',
    maxPrice: parseInt(req.query.max_price, 10) || '',
    sort: ch.SORTS[req.query.sort] ? req.query.sort : 'popular',
    page: Math.max(1, parseInt(req.query.page, 10) || 1),
    ...preset,
  };
  const result = ch.list(f);
  const category = f.category ? db.get('SELECT * FROM categories WHERE slug = ?', f.category) : null;
  if (f.category && !category) return res.status(404).render('error', { title: 'Не найдено', message: 'Категория не найдена.' });
  const tr = req.t;
  const title = req.path === '/ads' ? tr('💰 Реклама в Telegram-каналах')
    : category ? tr('{name} — Telegram', { name: tr(category.name) })
    : f.type ? tr('{type} Telegram', { type: tr(require('../helpers').TYPES_PLURAL[f.type]) })
    : f.q ? tr('Поиск: {q}', { q: f.q }) : tr('Каталог Telegram');
  res.render('catalog', { title, f, result, category, baseUrl: req.baseUrl + req.path });
}

router.get('/catalog', (req, res) => renderCatalog(req, res));
router.get('/search', rateLimit('search', { max: 120, windowMs: 60_000 }), (req, res) => renderCatalog(req, res));
router.get('/channels', (req, res) => renderCatalog(req, res, { type: 'channel' }));
router.get('/groups', (req, res) => renderCatalog(req, res, { type: 'group' }));
router.get('/bots', (req, res) => renderCatalog(req, res, { type: 'bot' }));
router.get('/ads', (req, res) => renderCatalog(req, res, { ads: true, sort: ch.SORTS[req.query.sort] ? req.query.sort : 'cpm' }));
router.get('/category/:slug', (req, res) => renderCatalog(req, res, { category: req.params.slug }));

const TOP_TABS = {
  subscribers: 'По подписчикам',
  growth_day: 'Рост за сутки',
  growth_week: 'Рост за неделю',
  growth_month: 'Рост за месяц',
  reach: 'По охвату',
  err: 'По ERR',
  votes: 'По голосам',
  rating: 'По отзывам',
};
router.get('/top', (req, res) => {
  const sort = TOP_TABS[req.query.by] ? req.query.by : 'subscribers';
  const type = TYPES[req.query.type] ? req.query.type : 'channel';
  const category = req.query.category || '';
  const language = LANGUAGES[req.query.language] ? req.query.language : '';
  const clean = req.query.clean === '1';
  const { items } = ch.list({ sort, type, category, language, clean, perPage: 100 });
  res.render('top', { title: req.t('Топ-100: {tab}', { tab: req.t(TOP_TABS[sort]) }), items, sort, type, category, language, clean, TOP_TABS });
});

router.get('/c/:username', (req, res) => {
  const channel = ch.byUsername(req.params.username);
  const visible = channel && (channel.status === 'approved' || (req.user && (req.user.role === 'admin' || channel.added_by === req.user.id)));
  if (!visible) return res.status(404).render('error', { title: 'Не найдено', message: 'Канал не найден или ещё на модерации.' });

  // Один просмотр на сессию на канал
  req.session.viewed = req.session.viewed || [];
  if (!req.session.viewed.includes(channel.id)) {
    db.run('UPDATE channels SET views = views + 1 WHERE id = ?', channel.id);
    req.session.viewed = [...req.session.viewed.slice(-50), channel.id];
  }

  const uid = req.user?.id;
  res.render('channel', {
    title: `${channel.title} (@${channel.username})`,
    channel,
    position: ch.rankPosition(channel),
    history: ch.history(channel.id, 90),
    reviews: db.all(`SELECT r.*, u.username FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? ORDER BY r.created_at DESC LIMIT 50`, channel.id),
    myReview: uid ? db.get('SELECT * FROM reviews WHERE channel_id = ? AND user_id = ?', channel.id, uid) : null,
    isFav: uid ? !!db.get('SELECT 1 FROM favorites WHERE channel_id = ? AND user_id = ?', channel.id, uid) : false,
    votedToday: uid ? !!db.get('SELECT 1 FROM votes WHERE channel_id = ? AND user_id = ? AND date = ?', channel.id, uid, ch.today()) : false,
    isOwner: uid && channel.owner_id === uid,
    canBoost: canBoost(channel),
    similar: ch.similar(channel),
    posts: db.all('SELECT * FROM posts WHERE channel_id = ? ORDER BY post_id DESC LIMIT 30', channel.id),
    fraudReasons: JSON.parse(channel.fraud_reasons || '[]'),
    fraud: fraudLevel(channel.fraud_score),
    deltas: dailyDeltas(ch.history(channel.id, 31)).map((d) => ({ date: d.date, delta: Math.round(d.delta) })),
    reachHistory: db.all(`SELECT date, avg_reach, err FROM stats WHERE channel_id = ? AND avg_reach IS NOT NULL ORDER BY date DESC LIMIT 90`, channel.id).reverse(),
    canRefresh: canRefresh(channel),
    owner: channel.owner_id ? db.get('SELECT id, username, rating_avg, rating_count, orders_done FROM users WHERE id = ?', channel.owner_id) : null,
  });
});

function canBoost(channel) {
  if (!channel.last_boost_at) return true;
  const last = new Date(channel.last_boost_at.replace(' ', 'T') + 'Z').getTime();
  return Date.now() - last >= config.boostCooldownHours * 3600 * 1000;
}

function loadChannel(req, res) {
  const channel = ch.byUsername(req.params.username);
  if (!channel || channel.status !== 'approved') {
    res.status(404).render('error', { title: 'Не найдено', message: 'Канал не найден.' });
    return null;
  }
  return channel;
}
const back = (req, res, c) => res.redirect(`/c/${c.username}`);

router.post('/c/:username/vote', requireUser, userLimit('vote', 60, 60), (req, res) => {
  const c = loadChannel(req, res); if (!c) return;
  const r = db.run('INSERT OR IGNORE INTO votes (user_id, channel_id, date) VALUES (?, ?, ?)', req.user.id, c.id, ch.today());
  if (r.changes) { db.run('UPDATE channels SET votes = votes + 1 WHERE id = ?', c.id); req.flash('success', 'Спасибо, ваш голос учтён!'); }
  else req.flash('info', 'Сегодня вы уже голосовали за этот канал. Возвращайтесь завтра.');
  back(req, res, c);
});

router.post('/c/:username/favorite', requireUser, (req, res) => {
  const c = loadChannel(req, res); if (!c) return;
  const r = db.run('DELETE FROM favorites WHERE user_id = ? AND channel_id = ?', req.user.id, c.id);
  if (!r.changes) db.run('INSERT INTO favorites (user_id, channel_id) VALUES (?, ?)', req.user.id, c.id);
  back(req, res, c);
});

router.post('/c/:username/review', requireUser, userLimit('review', 20, 60), (req, res) => {
  const c = loadChannel(req, res); if (!c) return;
  const rating = parseInt(req.body.rating, 10);
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!(rating >= 1 && rating <= 5)) { req.flash('error', 'Выберите оценку от 1 до 5.'); return back(req, res, c); }
  if (c.owner_id === req.user.id) { req.flash('error', 'Нельзя оценивать собственный канал.'); return back(req, res, c); }
  db.run(`INSERT INTO reviews (channel_id, user_id, rating, text) VALUES (?, ?, ?, ?)
          ON CONFLICT(channel_id, user_id) DO UPDATE SET rating = excluded.rating, text = excluded.text, created_at = datetime('now')`,
    c.id, req.user.id, rating, text);
  ch.refreshRating(c.id);
  req.flash('success', 'Отзыв сохранён.');
  back(req, res, c);
});

router.post('/c/:username/report', requireUser, userLimit('report', 10, 60), (req, res) => {
  const c = loadChannel(req, res); if (!c) return;
  const reason = String(req.body.reason || '').trim().slice(0, 1000);
  if (reason.length < 5) { req.flash('error', 'Опишите причину жалобы.'); return back(req, res, c); }
  db.run('INSERT INTO reports (channel_id, user_id, reason) VALUES (?, ?, ?)', c.id, req.user.id, reason);
  req.flash('success', 'Жалоба отправлена модераторам.');
  back(req, res, c);
});

// Обновить данные и анализ вручную (не чаще раза в 30 минут на канал)
router.post('/c/:username/refresh', requireUser, userLimit('refresh', 30, 60), async (req, res, next) => {
  try {
    const c = loadChannel(req, res); if (!c) return;
    if (!canRefresh(c) && req.user.role !== 'admin') {
      req.flash('info', req.t('Данные обновлялись недавно. Повторить можно через {n} минут.', { n: REFRESH_MINUTES }));
      return back(req, res, c);
    }
    const r = await syncChannel(c, { priority: 'high' }).catch((e) => ({ ok: false, error: e.message }));
    req.flash(r.ok ? 'success' : 'error', r.ok ? 'Данные и анализ обновлены.' : req.t('Не удалось обновить: {e}', { e: req.t(r.error) }));
    back(req, res, r.channel || c); // после объединения дублей адрес мог смениться на основной
  } catch (e) { next(e); }
});

// Бесплатное продвижение (этап 1): владелец поднимает канал в блок «Продвигаемые» на 24 часа раз в сутки
router.post('/c/:username/boost', requireUser, (req, res) => {
  const c = loadChannel(req, res); if (!c) return;
  if (c.owner_id !== req.user.id && req.user.role !== 'admin') { req.flash('error', 'Продвигать может только подтверждённый владелец канала.'); return back(req, res, c); }
  if (!config.freeMode) { req.flash('info', 'Платное продвижение скоро будет доступно.'); return back(req, res, c); }
  if (!canBoost(c)) { req.flash('info', req.t('Поднимать канал можно раз в {n} ч.', { n: config.boostCooldownHours })); return back(req, res, c); }
  db.run(`UPDATE channels SET boost_until = datetime('now', ?), last_boost_at = datetime('now') WHERE id = ?`, `+${config.boostHours} hours`, c.id);
  req.flash('success', req.t('Канал продвигается {n} ч. — бесплатно!', { n: config.boostHours }));
  back(req, res, c);
});

// Владение подтверждено: черновик публикуется (узбекский рынок) или уходит модератору
function confirmOwnership(req, c) {
  db.run('UPDATE channels SET owner_id = ? WHERE id = ? AND owner_id IS NULL', req.user.id, c.id);
  let msg = 'Владение подтверждено!';
  if (c.status === 'draft') {
    const fresh = db.get('SELECT is_uz FROM channels WHERE id = ?', c.id);
    const next = req.user.role === 'admin' || config.region !== 'uz' || fresh.is_uz ? 'approved' : 'pending';
    db.run(`UPDATE channels SET status = ?, approved_at = ${next === 'approved' ? "datetime('now')" : 'NULL'} WHERE id = ?`, next, c.id);
    msg += next === 'approved' ? ' Канал опубликован в каталоге.' : ' Канал отправлен на модерацию: модератор проверит, что он для узбекского рынка.';
  }
  req.flash('success', msg + ' Теперь вы можете указать цены на рекламу в настройках канала.');
}

// Подтверждение через бота: пользователь вошёл через Telegram, бот добавлен админом канала
router.post('/c/:username/verify-bot', requireUser, userLimit('verify', 20, 15), async (req, res, next) => {
  try {
    const c = ch.byUsername(req.params.username);
    if (!c || c.owner_id) return res.redirect(c ? `/c/${c.username}` : '/');
    const fail = (msg) => { req.flash('error', msg); res.redirect(`/c/${c.username}/claim`); };
    if (c.is_private || c.type === 'bot') return fail('Для этого канала используйте подтверждение кодом в описании.');
    if (!req.user.telegram_id) return fail('Сначала войдите через Telegram или привяжите Telegram к аккаунту.');
    let ok;
    try { ok = await isChannelAdmin(c.username, req.user.telegram_id); } catch (e) {
      return fail(req.t('Бот не смог проверить канал: {e}. Убедитесь, что @{bot} добавлен в администраторы канала.', { e: e.message, bot: config.botUsername }));
    }
    if (!ok) return fail('Ваш Telegram не числится создателем или администратором этого канала.');
    confirmOwnership(req, c);
    res.redirect(`/c/${c.username}`);
  } catch (e) { next(e); }
});

// Подтверждение владения: персональный код пользователя в описании канала
router.get('/c/:username/claim', requireUser, (req, res) => {
  const c = ch.byUsername(req.params.username);
  if (!c) return res.redirect('/');
  if (c.owner_id) { req.flash('info', 'Владелец канала уже подтверждён.'); return back(req, res, c); }
  res.render('claim', { title: 'Подтверждение владения', channel: c, code: ch.verifyCode(c.id, req.user.id), botMethod: !!config.botToken && !c.is_private && c.type !== 'bot' });
});

router.post('/c/:username/verify', requireUser, userLimit('verify', 20, 15), async (req, res, next) => {
  try {
    const c = ch.byUsername(req.params.username);
    if (!c || c.owner_id) return res.redirect(c ? `/c/${c.username}` : '/');
    const code = ch.verifyCode(c.id, req.user.id);
    const info = await fetchProfile(c, { priority: 'high' }).catch(() => null);
    if (info && info.description.includes(code)) {
      confirmOwnership(req, c);
      return res.redirect(`/c/${c.username}`);
    }
    req.flash('error', info ? 'Код не найден в описании. Telegram обновляет страницу с задержкой — попробуйте через минуту.' : 'Не удалось получить данные канала из Telegram.');
    res.redirect(`/c/${c.username}/claim`);
  } catch (e) { next(e); }
});

router.get('/add', requireUser, (req, res) => res.render('add', { title: 'Добавить канал', error: null, form: {} }));

router.post('/add', requireUser, userLimit('add', 15, 60), async (req, res, next) => {
  try {
    const form = {
      link: String(req.body.link || ''),
      category_id: parseInt(req.body.category_id, 10) || null,
      language: LANGUAGES[req.body.language] ? req.body.language : 'uz',
      tags: String(req.body.tags || '').slice(0, 200),
      consent: req.body.consent === '1',
    };
    const fail = (error) => res.status(400).render('add', { title: 'Добавить канал', error, form });
    const invite = parseInvite(form.link);
    const username = invite ? null : parseUsername(form.link);
    if (!invite && !username) return fail('Укажите ссылку вида https://t.me/username, @username или ссылку-приглашение частного канала https://t.me/+…');
    if (username) {
      const existing = db.get('SELECT username, status FROM channels WHERE username = ?', username);
      if (existing) return fail(req.t(existing.status === 'approved' ? '@{u} уже есть в каталоге.' : '@{u} уже добавлен и ожидает модерации.', { u: username }));
    }
    if (invite) {
      const existing = db.get('SELECT username FROM channels WHERE invite_link = ?', invite);
      if (existing) return fail('Этот частный канал уже добавлен.');
    }
    if (req.user.role !== 'admin' && !form.consent) return fail('Подтвердите, что вы владелец канала: добавлять каналы могут только их владельцы.');
    if (!form.category_id || !db.get('SELECT 1 FROM categories WHERE id = ?', form.category_id)) return fail('Выберите категорию.');

    const pending = db.get(`SELECT COUNT(*) AS n FROM channels WHERE added_by = ? AND status IN ('pending', 'draft')`, req.user.id).n;
    if (pending >= 20 && req.user.role !== 'admin') return fail('У вас слишком много каналов на модерации. Дождитесь проверки.');

    // Частный канал: служебный адрес на сайте вместо username
    const slug = username || 'private_' + crypto.randomBytes(5).toString('hex');
    let info;
    const HIGH = { priority: 'high' };
    try { info = invite ? await fetchInviteInfo(invite, slug, HIGH) : await fetchChannelInfo(username, HIGH); } catch { info = undefined; }
    if (info === null) return fail(invite ? 'Ссылка-приглашение недействительна или просрочена. Создайте постоянную ссылку в настройках канала.' : req.t('Не удалось найти @{u} в Telegram. Проверьте, что у канала публичная ссылка именно такая (Telegram → настройки канала → Тип канала → Публичная ссылка). Если ссылка верная, попробуйте ещё раз через минуту.', { u: username }));
    if (info && info.type === 'user') return fail('Это личный аккаунт. Добавлять можно только каналы, группы и ботов.');
    if (!info && invite) return fail('Не удалось получить данные канала из Telegram. Попробуйте позже.');
    info = info || { username, title: '@' + username, description: '', avatar_url: null, type: /bot$/i.test(username) ? 'bot' : 'channel', subscribers: 0, tg_verified: 0 };

    const isAdmin = req.user.role === 'admin';
    const uz = isAdmin || isUzbekMarket(info).ok;
    // Без подтверждения добавляет только админ. Остальные — черновик до подтверждения владения
    const status = isAdmin && !invite ? 'approved' : 'draft';
    const { lastInsertRowid } = db.run(`INSERT INTO channels (username, type, title, description, avatar_url, category_id, language, tags, subscribers, tg_verified, status, added_by, is_uz, is_private, invite_link, last_checked_at, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ${status === 'approved' ? "datetime('now')" : 'NULL'})`,
      slug, info.type, info.title, info.description, info.avatar_url, form.category_id, form.language, form.tags, info.subscribers, info.tg_verified,
      status, req.user.id, uz ? 1 : 0, invite ? 1 : 0, invite);
    const id = Number(lastInsertRowid);
    ch.recordStats(id, info.subscribers);
    const page = info.type === 'channel' && !invite ? await syncPosts(id, username, HIGH).catch(() => null) : null;
    analyze(id);
    // Добавили второй адрес канала, который уже есть в каталоге, — ведём на основную карточку
    if (page?.canonical && page.canonical.toLowerCase() !== username.toLowerCase()) {
      const main = require('../dedupe').resolveAlias(db.get('SELECT * FROM channels WHERE id = ?', id), page.canonical);
      if (main.id !== id) {
        req.flash('info', req.t('Этот канал уже есть в каталоге под основным адресом @{u}. Подтвердите владение на его странице.', { u: main.username }));
        return res.redirect(`/c/${main.username}`);
      }
    }

    if (status === 'draft') {
      req.flash('info', 'Канал сохранён как черновик и пока никому не виден. Подтвердите, что вы владелец, — после этого он появится в каталоге.');
      return res.redirect(`/c/${slug}/claim`);
    }
    req.flash('success', status === 'approved' ? 'Канал добавлен.' : 'Канал отправлен на модерацию. Обычно проверка занимает до 24 часов.' +
      (config.region === 'uz' && !uz ? ' Каталог принимает каналы для узбекского рынка — укажите в описании, что канал связан с Узбекистаном, это ускорит проверку.' : ''));
    res.redirect(`/c/${slug}`);
  } catch (e) { next(e); }
});

router.get('/pricing', (req, res) => res.render('pricing', { title: 'Тарифы' }));
router.get('/faq', (req, res) => res.render('faq', { title: 'Вопросы и ответы' }));
router.get('/api-docs', (req, res) => res.render('api-docs', { title: 'API' }));

router.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /account\nDisallow: /healthz\nSitemap: ${config.baseUrl}/sitemap.xml\n`));
router.get('/sitemap.xml', (req, res) => {
  const urls = ['/', '/catalog', '/top', '/channels', '/groups', '/bots',
    ...db.all('SELECT slug FROM categories').map((c) => `/category/${c.slug}`),
    ...db.all(`SELECT username FROM channels WHERE status = 'approved' ORDER BY subscribers DESC LIMIT 45000`).map((c) => `/c/${c.username}`)];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${config.baseUrl}${u}</loc></url>`).join('\n')}\n</urlset>`);
});

module.exports = router;
