// Заказы на рекламу: заказчик → владелец канала. Завершённые заказы дают право поставить оценку 1–10.
const express = require('express');
const db = require('../db');
const social = require('../social');
const ads = require('../ads');
const { requireUser } = require('./guards');

const router = express.Router();
router.use(requireUser);

router.get('/', (req, res) => {
  const q = `SELECT o.*, cu.username AS customer_name, ex.username AS executor_name, c.username AS channel_username, c.is_private
    FROM orders o JOIN users cu ON cu.id = o.customer_id JOIN users ex ON ex.id = o.executor_id LEFT JOIN channels c ON c.id = o.channel_id`;
  res.render('orders/index', {
    title: 'Заказы',
    incoming: db.all(`${q} WHERE o.executor_id = ? ORDER BY o.updated_at DESC LIMIT 200`, req.user.id),
    outgoing: db.all(`${q} WHERE o.customer_id = ? ORDER BY o.updated_at DESC LIMIT 200`, req.user.id),
    ORDER_STATUS: social.ORDER_STATUS,
  });
});

function adChannel(id) {
  return db.get(`SELECT * FROM channels WHERE id = ? AND status = 'approved' AND ads_enabled = 1 AND owner_id IS NOT NULL`, id);
}

router.get('/new', (req, res) => {
  const channel = adChannel(Number(req.query.channel));
  if (!channel) return res.status(404).render('error', { title: 'Не найдено', message: 'Канал не принимает заказы на рекламу.' });
  if (channel.owner_id === req.user.id) return res.redirect(`/c/${channel.username}`);
  res.render('orders/new', { title: 'Заказать рекламу', channel, prices: JSON.parse(channel.ad_prices || '[]'), error: null, form: { format: req.query.format || '' } });
});

router.post('/new', (req, res) => {
  const channel = adChannel(Number(req.body.channel_id));
  if (!channel) return res.status(404).render('error', { title: 'Не найдено', message: 'Канал не принимает заказы на рекламу.' });
  const prices = JSON.parse(channel.ad_prices || '[]');
  const form = {
    format: String(req.body.format || '').trim().slice(0, 40),
    price: Math.round(Number(String(req.body.price || '').replace(/[\s ,]/g, ''))) || null,
    publish_date: /^\d{4}-\d{2}-\d{2}$/.test(req.body.publish_date || '') ? req.body.publish_date : null,
    note: String(req.body.note || '').trim().slice(0, 2000),
  };
  const fail = (error) => res.status(400).render('orders/new', { title: 'Заказать рекламу', channel, prices, error, form });
  if (channel.owner_id === req.user.id) return fail('Нельзя заказать рекламу в собственном канале.');
  if (!form.format) return fail('Выберите или укажите формат размещения.');
  if (form.note.length < 10) return fail('Опишите, что нужно разместить: тема, ссылка, пожелания по времени.');
  const open = db.get(`SELECT COUNT(*) AS n FROM orders WHERE customer_id = ? AND status = 'new'`, req.user.id).n;
  if (open >= 20) return fail('У вас слишком много заказов без ответа. Дождитесь ответа владельцев.');
  // Цена по прайсу, если формат из прайса и цену не указали
  if (!form.price) form.price = prices.find((p) => p.format === form.format)?.price || null;

  const { lastInsertRowid } = db.run(`INSERT INTO orders (channel_id, channel_title, customer_id, executor_id, format, price, currency, publish_date, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, channel.id, channel.title, req.user.id, channel.owner_id, form.format, form.price, channel.ad_currency, form.publish_date, form.note);
  const order = db.get('SELECT * FROM orders WHERE id = ?', lastInsertRowid);
  social.orderEvent(order, req.user.id, `📦 Новый заказ #${order.id}: ${form.format}${form.price ? ', ' + ads.fmtPrice(form.price, order.currency) : ''} в «${channel.title}».\n${form.note}`);
  req.flash('success', 'Заказ отправлен владельцу канала. Ответ придёт в «Сообщения» и «Заказы».');
  res.redirect(`/orders/${order.id}`);
});

function loadOrder(req, res) {
  const o = db.get(`SELECT o.*, c.username AS channel_username, c.is_private FROM orders o LEFT JOIN channels c ON c.id = o.channel_id
    WHERE o.id = ? AND (o.customer_id = ? OR o.executor_id = ?)`, Number(req.params.id), req.user.id, req.user.id);
  if (!o) { res.status(404).render('error', { title: 'Не найдено', message: 'Заказ не найден.' }); return null; }
  return o;
}

router.get('/:id', (req, res) => {
  const o = loadOrder(req, res); if (!o) return;
  const isCustomer = o.customer_id === req.user.id;
  const otherId = isCustomer ? o.executor_id : o.customer_id;
  const conv = social.getOrCreateConversation(o.customer_id, o.executor_id, o.channel_id);
  res.render('orders/show', {
    title: `Заказ #${o.id}`,
    order: o, isCustomer, conv,
    customer: social.publicUser(o.customer_id),
    executor: social.publicUser(o.executor_id),
    other: social.publicUser(otherId),
    myRating: db.get('SELECT * FROM user_ratings WHERE order_id = ? AND from_user = ?', o.id, req.user.id),
    theirRating: db.get('SELECT * FROM user_ratings WHERE order_id = ? AND from_user = ?', o.id, otherId),
    ORDER_STATUS: social.ORDER_STATUS,
  });
});

// Оценка 1–10 после завершения заказа: заказчик оценивает исполнителя и наоборот
router.post('/:id/rate', (req, res) => {
  const o = loadOrder(req, res); if (!o) return;
  const score = parseInt(req.body.score, 10);
  if (o.status !== 'completed') { req.flash('error', 'Оценку можно поставить после завершения заказа.'); return res.redirect(`/orders/${o.id}`); }
  if (!(score >= 1 && score <= 10)) { req.flash('error', 'Выберите оценку от 1 до 10.'); return res.redirect(`/orders/${o.id}`); }
  const to = o.customer_id === req.user.id ? o.executor_id : o.customer_id;
  db.run(`INSERT INTO user_ratings (order_id, from_user, to_user, score, text) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(order_id, from_user) DO UPDATE SET score = excluded.score, text = excluded.text, created_at = datetime('now')`,
    o.id, req.user.id, to, score, String(req.body.text || '').trim().slice(0, 1000));
  social.refreshUserRating(to);
  req.flash('success', 'Спасибо, оценка сохранена.');
  res.redirect(`/orders/${o.id}`);
});

// Переходы статусов: кто и из какого статуса может перевести заказ
const TRANSITIONS = {
  accept: { who: 'executor', from: ['new'], to: 'accepted', text: '✅ Заказ #{id} принят в работу.' },
  decline: { who: 'executor', from: ['new'], to: 'declined', text: '❌ Заказ #{id} отклонён.' },
  cancel: { who: 'customer', from: ['new', 'accepted'], to: 'cancelled', text: '🚫 Заказ #{id} отменён заказчиком.' },
  done: { who: 'executor', from: ['accepted'], to: 'done', text: '📢 Реклама по заказу #{id} размещена. Заказчик, проверьте и подтвердите выполнение.' },
  complete: { who: 'customer', from: ['done', 'accepted'], to: 'completed', text: '🏁 Заказ #{id} завершён. Оцените друг друга от 1 до 10.' },
  reopen: { who: 'customer', from: ['done'], to: 'accepted', text: '↩️ Заказчик вернул заказ #{id} в работу: размещение не подтверждено.' },
};

router.post('/:id/:action', (req, res) => {
  const o = loadOrder(req, res); if (!o) return;
  const t = TRANSITIONS[req.params.action];
  const role = o.customer_id === req.user.id ? 'customer' : 'executor';
  if (!t || t.who !== role || !t.from.includes(o.status)) {
    req.flash('error', 'Это действие сейчас недоступно.');
    return res.redirect(`/orders/${o.id}`);
  }
  db.run(`UPDATE orders SET status = ?, updated_at = datetime('now'), completed_at = ${t.to === 'completed' ? "datetime('now')" : 'completed_at'} WHERE id = ?`, t.to, o.id);
  social.orderEvent(o, req.user.id, t.text.replace('{id}', o.id));
  if (t.to === 'completed') social.refreshUserRating(o.executor_id);
  res.redirect(`/orders/${o.id}`);
});

module.exports = router;
