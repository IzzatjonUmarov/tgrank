// Публичные профили и рейтинг пользователей (1–10 по завершённым заказам)
const express = require('express');
const db = require('../db');
const social = require('../social');

const router = express.Router();

router.get('/users', (req, res) => {
  const users = db.all(`SELECT id, username, rating_avg, rating_count, orders_done, created_at FROM users
    WHERE banned = 0 AND rating_count > 0
    ORDER BY (rating_avg * rating_count + 7 * 2) / (rating_count + 2) DESC, orders_done DESC LIMIT 100`);
  res.render('users/top', { title: 'Рейтинг пользователей', users });
});

router.get('/u/:id', (req, res) => {
  const u = social.publicUser(Number(req.params.id));
  if (!u || u.banned) return res.status(404).render('error', { title: 'Не найдено', message: 'Пользователь не найден.' });
  res.render('users/show', {
    title: u.username,
    profile: u,
    ratings: db.all(`SELECT r.*, u.username AS from_name, o.format, o.channel_title, o.customer_id FROM user_ratings r
      JOIN users u ON u.id = r.from_user JOIN orders o ON o.id = r.order_id WHERE r.to_user = ? ORDER BY r.created_at DESC LIMIT 100`, u.id),
    channels: db.all(`SELECT c.*, cat.name AS category_name FROM channels c LEFT JOIN categories cat ON cat.id = c.category_id
      WHERE c.owner_id = ? AND c.status = 'approved' ORDER BY c.subscribers DESC`, u.id),
    stats: db.get(`SELECT
      (SELECT COUNT(*) FROM orders WHERE executor_id = ? AND status = 'completed') AS as_executor,
      (SELECT COUNT(*) FROM orders WHERE customer_id = ? AND status = 'completed') AS as_customer`, u.id, u.id),
  });
});

module.exports = router;
