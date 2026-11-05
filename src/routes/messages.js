const express = require('express');
const db = require('../db');
const social = require('../social');
const { requireUser } = require('./guards');

const router = express.Router();
router.use(requireUser);

router.get('/', (req, res) => {
  res.render('messages/index', { title: 'Сообщения', convs: social.inbox(req.user.id).map((c) => ({ ...c, last_text: social.displayText(c.last_kind, c.last_text, req.t) })) });
});

// Начать переписку с пользователем (из профиля или со страницы канала)
router.get('/with/:userId', (req, res) => {
  const other = social.publicUser(Number(req.params.userId));
  if (!other || other.banned) return res.status(404).render('error', { title: 'Не найдено', message: 'Пользователь не найден.' });
  if (other.id === req.user.id) return res.redirect('/messages');
  const channelId = parseInt(req.query.channel, 10) || null;
  const conv = social.getOrCreateConversation(req.user.id, other.id, channelId);
  res.redirect(`/messages/${conv.id}${channelId ? `?channel=${channelId}` : ''}`);
});

function loadConv(req, res) {
  const conv = social.conversationFor(Number(req.params.id), req.user.id);
  if (!conv) { res.status(404).render('error', { title: 'Не найдено', message: 'Переписка не найдена.' }); return null; }
  return conv;
}

router.get('/:id', (req, res) => {
  const conv = loadConv(req, res); if (!conv) return;
  social.markRead(conv.id, req.user.id);
  const other = social.publicUser(social.otherUser(conv, req.user.id));
  const channelId = parseInt(req.query.channel, 10) || conv.channel_id;
  res.render('messages/thread', {
    title: req.t('Переписка с {name}', { name: other.username }),
    conv, other,
    messages: social.messagesOf(conv.id).map((m) => ({ ...m, text: social.displayText(m.kind, m.text, req.t) })),
    channel: channelId ? db.get(`SELECT id, username, title, is_private FROM channels WHERE id = ? AND status = 'approved'`, channelId) : null,
    orders: db.all(`SELECT * FROM orders WHERE (customer_id = ? AND executor_id = ?) OR (customer_id = ? AND executor_id = ?) ORDER BY id DESC LIMIT 10`,
      req.user.id, other.id, other.id, req.user.id),
    ORDER_STATUS: social.ORDER_STATUS,
  });
});

router.post('/:id', (req, res) => {
  const conv = loadConv(req, res); if (!conv) return;
  const text = String(req.body.text || '').trim();
  const other = social.publicUser(social.otherUser(conv, req.user.id));
  const ajax = req.get('x-requested-with') === 'fetch';
  const fail = (msg) => (ajax ? res.status(400).json({ error: msg }) : (req.flash('error', msg), res.redirect(`/messages/${conv.id}`)));
  if (!text) return fail('Сообщение пустое.');
  if (!other || other.banned) return fail('Пользователь заблокирован.');
  if (!social.canSend(req.user.id)) return fail('Слишком много сообщений за час. Попробуйте позже.');
  const id = social.sendMessage(conv.id, req.user.id, text);
  if (ajax) return res.json({ ok: true, id });
  res.redirect(`/messages/${conv.id}#m${id}`);
});

// Новые сообщения для автообновления переписки
router.get('/:id/poll', (req, res) => {
  const conv = social.conversationFor(Number(req.params.id), req.user.id);
  if (!conv) return res.status(404).json({ error: 'not_found' });
  const items = social.messagesOf(conv.id, parseInt(req.query.after, 10) || 0);
  social.markRead(conv.id, req.user.id);
  res.set('Cache-Control', 'no-store').json(items.map((m) => ({
    id: m.id, mine: m.sender_id === req.user.id, kind: m.kind, text: social.displayText(m.kind, m.text, req.t), order_id: m.order_id,
    sender: m.sender_name, at: m.created_at,
  })));
});

router.get('/api/unread', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ messages: social.unreadMessages(req.user.id), orders: social.ordersNeedingAction(req.user.id) });
});

module.exports = router;
