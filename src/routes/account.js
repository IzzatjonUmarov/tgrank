const express = require('express');
const db = require('../db');
const ch = require('../channels');
const { requireUser } = require('./guards');
const { LANGUAGES } = require('../helpers');

const router = express.Router();
router.use(requireUser);

router.get('/', (req, res) => {
  const uid = req.user.id;
  const mine = db.all(`SELECT c.*, cat.name AS category_name, (c.boost_until > datetime('now')) AS boosted
    FROM channels c LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.added_by = ? OR c.owner_id = ? ORDER BY c.created_at DESC`, uid, uid);
  const favorites = db.all(`SELECT c.*, cat.name AS category_name FROM favorites f
    JOIN channels c ON c.id = f.channel_id LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE f.user_id = ? AND c.status = 'approved' ORDER BY f.created_at DESC`, uid);
  res.render('account/index', { title: 'Личный кабинет', mine, favorites });
});

function ownChannel(req, res) {
  const c = ch.byId(Number(req.params.id));
  if (!c || (c.owner_id !== req.user.id && req.user.role !== 'admin')) {
    res.status(403).render('error', { title: 'Нет доступа', message: 'Редактировать канал может только подтверждённый владелец.' });
    return null;
  }
  return c;
}

router.get('/channel/:id/edit', (req, res) => {
  const c = ownChannel(req, res); if (!c) return;
  res.render('account/edit', { title: 'Настройки канала', channel: c });
});

router.post('/channel/:id/edit', (req, res) => {
  const c = ownChannel(req, res); if (!c) return;
  const categoryId = parseInt(req.body.category_id, 10);
  const language = LANGUAGES[req.body.language] ? req.body.language : c.language;
  const tags = String(req.body.tags || '').slice(0, 200);
  db.run('UPDATE channels SET category_id = COALESCE(?, category_id), language = ?, tags = ? WHERE id = ?',
    db.get('SELECT id FROM categories WHERE id = ?', categoryId)?.id ?? null, language, tags, c.id);
  req.flash('success', 'Изменения сохранены.');
  res.redirect(`/c/${c.username}`);
});

router.post('/channel/:id/delete', (req, res) => {
  const c = ownChannel(req, res); if (!c) return;
  db.run('DELETE FROM channels WHERE id = ?', c.id);
  req.flash('success', `@${c.username} удалён из каталога.`);
  res.redirect('/account');
});

module.exports = router;
