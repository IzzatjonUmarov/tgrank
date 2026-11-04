// Сообщения между пользователями, заказы на рекламу и рейтинг пользователей (1–10)
const db = require('./db');

const ORDER_STATUS = {
  new: 'Новый',
  accepted: 'Принят в работу',
  done: 'Выполнен, ждёт подтверждения',
  completed: 'Завершён',
  declined: 'Отклонён',
  cancelled: 'Отменён',
};
const MESSAGE_LIMIT_PER_HOUR = 60;

function pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function getOrCreateConversation(userId, otherId, channelId = null) {
  const [a, b] = pair(userId, otherId);
  let conv = db.get('SELECT * FROM conversations WHERE user_a = ? AND user_b = ?', a, b);
  if (!conv) {
    const { lastInsertRowid } = db.run('INSERT INTO conversations (user_a, user_b, channel_id) VALUES (?, ?, ?)', a, b, channelId);
    conv = db.get('SELECT * FROM conversations WHERE id = ?', lastInsertRowid);
  }
  return conv;
}

function conversationFor(id, userId) {
  return db.get('SELECT * FROM conversations WHERE id = ? AND (user_a = ? OR user_b = ?)', id, userId, userId);
}

function otherUser(conv, userId) {
  return conv.user_a === userId ? conv.user_b : conv.user_a;
}

function canSend(userId) {
  const n = db.get(`SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND kind = 'text' AND created_at >= datetime('now', '-1 hour')`, userId).n;
  return n < MESSAGE_LIMIT_PER_HOUR;
}

function sendMessage(convId, senderId, text, { kind = 'text', orderId = null } = {}) {
  const { lastInsertRowid } = db.run('INSERT INTO messages (conversation_id, sender_id, kind, text, order_id) VALUES (?, ?, ?, ?, ?)',
    convId, senderId, kind, String(text).slice(0, 2000), orderId);
  db.run(`UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?`, convId);
  return Number(lastInsertRowid);
}

// Служебное сообщение о заказе в переписку заказчика и исполнителя
function orderEvent(order, actorId, text) {
  const conv = getOrCreateConversation(order.customer_id, order.executor_id, order.channel_id);
  sendMessage(conv.id, actorId, text, { kind: 'system', orderId: order.id });
}

function markRead(convId, userId) {
  db.run(`UPDATE messages SET read_at = datetime('now') WHERE conversation_id = ? AND read_at IS NULL AND (sender_id IS NULL OR sender_id != ?)`, convId, userId);
}

function unreadMessages(userId) {
  return db.get(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.user_a = ? OR c.user_b = ?) AND m.read_at IS NULL AND (m.sender_id IS NULL OR m.sender_id != ?)`, userId, userId, userId).n;
}

// Заказы, где от пользователя ждут действия
function ordersNeedingAction(userId) {
  return db.get(`SELECT COUNT(*) AS n FROM orders WHERE (executor_id = ? AND status IN ('new', 'accepted')) OR (customer_id = ? AND status = 'done')`, userId, userId).n;
}

function inbox(userId) {
  return db.all(`SELECT c.*, u.id AS other_id, u.username AS other_name, u.rating_avg AS other_rating, u.rating_count AS other_rating_count,
      (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_text,
      (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id AND read_at IS NULL AND (sender_id IS NULL OR sender_id != ?)) AS unread
    FROM conversations c JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
    WHERE (c.user_a = ? OR c.user_b = ?) AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id)
    ORDER BY c.last_message_at DESC LIMIT 200`, userId, userId, userId, userId);
}

function messagesOf(convId, afterId = 0) {
  return db.all(`SELECT m.*, u.username AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id LIMIT 500`, convId, afterId);
}

function refreshUserRating(userId) {
  db.run(`UPDATE users SET
      rating_avg = COALESCE((SELECT AVG(score) FROM user_ratings WHERE to_user = ?), 0),
      rating_count = (SELECT COUNT(*) FROM user_ratings WHERE to_user = ?),
      orders_done = (SELECT COUNT(*) FROM orders WHERE executor_id = ? AND status = 'completed')
    WHERE id = ?`, userId, userId, userId, userId);
}

function publicUser(id) {
  return db.get('SELECT id, username, role, banned, created_at, rating_avg, rating_count, orders_done, about FROM users WHERE id = ?', id);
}

module.exports = {
  ORDER_STATUS, getOrCreateConversation, conversationFor, otherUser, canSend, sendMessage, orderEvent,
  markRead, unreadMessages, ordersNeedingAction, inbox, messagesOf, refreshUserRating, publicUser,
};
