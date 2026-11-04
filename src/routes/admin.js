const express = require('express');
const db = require('../db');
const ch = require('../channels');
const { requireAdmin } = require('./guards');
const { updateAll, isRunning } = require('../stats');
const importer = require('../importer');
const { syncChannel } = require('../sync');
const { nonUzbek, removeChannels } = require('../region');

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  res.render('admin/index', {
    title: 'Админка',
    counts: db.get(`SELECT
      (SELECT COUNT(*) FROM channels WHERE status = 'pending') AS pending,
      (SELECT COUNT(*) FROM channels WHERE status = 'approved') AS approved,
      (SELECT COUNT(*) FROM channels WHERE status = 'rejected') AS rejected,
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM reviews) AS reviews,
      (SELECT COUNT(*) FROM reports WHERE resolved = 0) AS reports,
      (SELECT COUNT(*) FROM channels WHERE boost_until > datetime('now')) AS boosted,
      (SELECT COUNT(*) FROM users WHERE created_at >= datetime('now','-1 day')) AS users_day,
      (SELECT COUNT(*) FROM channels WHERE created_at >= datetime('now','-1 day')) AS channels_day,
      (SELECT COUNT(*) FROM channels WHERE status = 'approved' AND fraud_score >= 25) AS suspicious`),
    queue: importer.queueStats(),
    statsRunning: isRunning(),
  });
});

router.get('/channels', (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const suspicious = req.query.suspicious === '1';
  const result = ch.list({ status, q: req.query.q, suspicious, sort: status === 'pending' ? 'new' : 'subscribers', page: parseInt(req.query.page, 10) || 1, perPage: 50 });
  if (suspicious) result.items.sort((a, b) => b.fraud_score - a.fraud_score);
  if (status === 'pending') result.items.reverse(); // старые заявки первыми
  res.render('admin/channels', { title: 'Каналы', status, result, suspicious, q: req.query.q || '' });
});

const goBack = (req, res) => res.redirect(req.get('referer') || '/admin/channels');

router.post('/channels/:id/approve', (req, res) => {
  const c = db.get('SELECT is_private, owner_id FROM channels WHERE id = ?', Number(req.params.id));
  if (c && c.is_private && !c.owner_id) { req.flash('error', 'Частный канал можно одобрить только после подтверждения владельца.'); return goBack(req, res); }
  db.run(`UPDATE channels SET status = 'approved', reject_reason = NULL, approved_at = COALESCE(approved_at, datetime('now')) WHERE id = ?`, Number(req.params.id));
  goBack(req, res);
});
router.post('/channels/:id/reject', (req, res) => {
  db.run(`UPDATE channels SET status = 'rejected', reject_reason = ? WHERE id = ?`, String(req.body.reason || '').slice(0, 500) || null, Number(req.params.id));
  goBack(req, res);
});
router.post('/channels/:id/feature', (req, res) => {
  db.run('UPDATE channels SET featured = 1 - featured WHERE id = ?', Number(req.params.id));
  goBack(req, res);
});
router.post('/channels/:id/unboost', (req, res) => {
  db.run('UPDATE channels SET boost_until = NULL WHERE id = ?', Number(req.params.id));
  goBack(req, res);
});
router.post('/channels/:id/reset-owner', (req, res) => {
  db.run('UPDATE channels SET owner_id = NULL, ads_enabled = 0 WHERE id = ?', Number(req.params.id));
  goBack(req, res);
});
router.post('/channels/:id/category', (req, res) => {
  db.run('UPDATE channels SET category_id = ? WHERE id = ?', parseInt(req.body.category_id, 10) || null, Number(req.params.id));
  goBack(req, res);
});
router.post('/channels/:id/refresh', async (req, res, next) => {
  try {
    const c = ch.byId(Number(req.params.id));
    const r = c ? await syncChannel(c, { priority: 'high' }).catch((e) => ({ ok: false, error: e.message })) : { ok: false, error: 'не найден' };
    if (r.ok) req.flash('success', `@${c.username}: ${r.info.subscribers} подписчиков, риск накрутки ${r.analysis.score}/100.`);
    else req.flash('error', `Не удалось обновить: ${r.error}`);
    goBack(req, res);
  } catch (e) { next(e); }
});
router.post('/channels/:id/delete', (req, res) => {
  db.run('DELETE FROM channels WHERE id = ?', Number(req.params.id));
  goBack(req, res);
});
router.post('/stats/update', (req, res) => {
  updateAll();
  req.flash('info', 'Обновление статистики запущено в фоне.');
  res.redirect('/admin');
});

router.get('/users', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const users = db.all(`SELECT u.*, (SELECT COUNT(*) FROM channels WHERE added_by = u.id) AS added
    FROM users u WHERE u.username LIKE ? OR COALESCE(u.email,'') LIKE ? ORDER BY u.id DESC LIMIT 200`, q, q);
  res.render('admin/users', { title: 'Пользователи', users, q: req.query.q || '' });
});
router.post('/users/:id/ban', (req, res) => {
  if (Number(req.params.id) !== req.user.id) db.run('UPDATE users SET banned = 1 - banned WHERE id = ?', Number(req.params.id));
  goBack(req, res);
});
router.post('/users/:id/role', (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (Number(req.params.id) !== req.user.id) db.run('UPDATE users SET role = ? WHERE id = ?', role, Number(req.params.id));
  goBack(req, res);
});

router.get('/categories', (req, res) => {
  const cats = db.all(`SELECT cat.*, (SELECT COUNT(*) FROM channels WHERE category_id = cat.id) AS n FROM categories cat ORDER BY sort, name`);
  res.render('admin/categories', { title: 'Категории', cats });
});
router.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim();
  const slug = String(req.body.slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (name && slug) {
    db.run(`INSERT INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?)
            ON CONFLICT(slug) DO UPDATE SET name = excluded.name, icon = excluded.icon, sort = excluded.sort`,
      slug, name, String(req.body.icon || '📁').slice(0, 8), parseInt(req.body.sort, 10) || 0);
  } else req.flash('error', 'Укажите название и slug (латиница).');
  res.redirect('/admin/categories');
});
router.post('/categories/:id/delete', (req, res) => {
  db.run('DELETE FROM categories WHERE id = ?', Number(req.params.id));
  res.redirect('/admin/categories');
});

router.get('/reports', (req, res) => {
  const reports = db.all(`SELECT r.*, c.username, c.title, c.is_private, c.invite_link, u.username AS reporter FROM reports r
    JOIN channels c ON c.id = r.channel_id LEFT JOIN users u ON u.id = r.user_id
    ORDER BY r.resolved, r.created_at DESC LIMIT 200`);
  res.render('admin/reports', { title: 'Жалобы', reports });
});
router.post('/reports/:id/resolve', (req, res) => {
  db.run('UPDATE reports SET resolved = 1 WHERE id = ?', Number(req.params.id));
  goBack(req, res);
});

router.get('/reviews', (req, res) => {
  const reviews = db.all(`SELECT r.*, c.username AS channel, u.username FROM reviews r
    JOIN channels c ON c.id = r.channel_id JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 200`);
  res.render('admin/reviews', { title: 'Отзывы', reviews });
});
router.post('/reviews/:id/delete', (req, res) => {
  const r = db.get('SELECT channel_id FROM reviews WHERE id = ?', Number(req.params.id));
  if (r) { db.run('DELETE FROM reviews WHERE id = ?', Number(req.params.id)); ch.refreshRating(r.channel_id); }
  goBack(req, res);
});

router.get('/region', (req, res) => {
  res.render('admin/region', { title: 'Только Узбекистан', items: nonUzbek() });
});
router.post('/region', (req, res) => {
  const ids = new Set([].concat(req.body.ids || []).map(Number));
  const n = removeChannels(nonUzbek().filter((c) => ids.has(c.id)));
  req.flash('success', `Удалено каналов: ${n}.`);
  res.redirect('/admin/region');
});
router.post('/channels/:id/mark-uz', (req, res) => {
  db.run('UPDATE channels SET is_uz = 1 WHERE id = ?', Number(req.params.id));
  goBack(req, res);
});

// Диагностика: что Telegram отдаёт по username (помогает разобраться, почему канал «не найден»)
router.get('/tme', async (req, res, next) => {
  try {
    const tg = require('../telegram');
    const username = tg.parseUsername(req.query.u || '');
    let result = null;
    if (username) {
      const probe = async (path) => {
        try {
          const html = await tg.tmeGet(path, { priority: 'high' });
          const last = tg.queueSize().last;
          const has = (re) => re.test(html);
          return {
            path, status: last?.status, finalUrl: last?.url, length: html.length,
            marks: {
              tgme_page_title: has(/class="tgme_page_title"/), tgme_page_extra: has(/class="tgme_page_extra"/),
              channel_preview: has(/tgme_channel_info_header_title/), posts: has(/tgme_widget_message_wrap/),
              og_title: (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || null,
            },
            parsed: path.startsWith('s/') ? tg.parsePreview(html, username) : tg.parsePage(html, username),
            snippet: html.replace(/\s+/g, ' ').slice(0, 1500),
          };
        } catch (e) { return { path, error: e.message }; }
      };
      result = { username, page: await probe(username), preview: await probe(`s/${username}`) };
    }
    res.render('admin/tme', { title: 'Диагностика t.me', q: req.query.u || '', result, queue: tg.queueSize() });
  } catch (e) { next(e); }
});

router.get('/import', (req, res) => {
  const status = ['queued', 'done', 'failed', 'skipped'].includes(req.query.status) ? req.query.status : 'queued';
  res.render('admin/import', {
    title: 'Импорт каналов',
    queue: importer.queueStats(),
    crawl: require('../crawler').crawlStats(),
    status,
    items: db.all(`SELECT * FROM import_queue WHERE status = ? ORDER BY ${status === 'queued' ? "CASE source WHEN 'admin' THEN 0 WHEN 'seed' THEN 1 ELSE 2 END, mentions DESC, added_at" : 'COALESCE(processed_at, added_at) DESC'} LIMIT 200`, status),
  });
});
router.post('/import', (req, res) => {
  const lines = String(req.body.list || '').split(/[\s,;]+/).filter(Boolean).slice(0, 5000);
  const r = importer.enqueue(lines, {
    source: 'admin',
    categoryId: parseInt(req.body.category_id, 10) || null,
    approve: req.body.approve === '1',
    regionCheck: req.body.region_check === '1',
  });
  req.flash('success', `В очередь добавлено: ${r.added}. Пропущено (дубли, уже в каталоге, неверный формат): ${r.skipped}.`);
  res.redirect('/admin/import');
});
router.post('/import/retry', (req, res) => {
  const r = db.run(`UPDATE import_queue SET status = 'queued', attempts = 0, error = NULL WHERE status = 'failed'`);
  req.flash('info', `Повторно в очереди: ${r.changes}.`);
  res.redirect('/admin/import');
});
router.post('/import/clear', (req, res) => {
  const r = db.run(`DELETE FROM import_queue WHERE status = 'queued' AND source = 'discovery'`);
  req.flash('info', `Удалено из очереди автопоиска: ${r.changes}.`);
  res.redirect('/admin/import');
});

module.exports = router;
