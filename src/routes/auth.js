const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { checkTelegramAuth } = require('../telegram');
const crypto = require('node:crypto');
const { safeNext, rateLimit, registerFailure, isLocked, clearFailures, tokensEqual } = require('../security');

const router = express.Router();

// Роль админа: по Telegram ID (надёжно) или по ADMIN_EMAIL, если Telegram ID не заданы.
// «Первый пользователь — админ» — только для локального запуска без https.
function roleFor({ email = '', telegramId = null } = {}) {
  if (config.adminTelegramIds.length) return telegramId && config.adminTelegramIds.includes(Number(telegramId)) ? 'admin' : 'user';
  if (config.adminEmail) return email && email === config.adminEmail ? 'admin' : 'user';
  const local = !config.baseUrl.startsWith('https://');
  return local && db.get('SELECT COUNT(*) AS n FROM users').n === 0 ? 'admin' : 'user';
}

// Новая сессия при входе: свежий CSRF-токен, чтобы старый не переживал смену пользователя
function startSession(req, userId) {
  req.session.uid = userId;
  req.session.csrf = crypto.randomBytes(16).toString('hex');
  req.session.tgState = null;
}

// Хэш-заглушка: при несуществующем email тратим столько же времени, сколько на проверку пароля
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

const loginLimit = rateLimit('login', { max: 20, windowMs: 15 * 60_000 });
const registerLimit = rateLimit('register', { max: 5, windowMs: 60 * 60_000 });

router.get('/login', (req, res) => res.render('login', { title: 'Вход', next: safeNext(req.query.next), error: null, email: '' }));

router.post('/login', loginLimit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const next = safeNext(req.body.next);
  const fail = (status, error) => res.status(status).render('login', { title: 'Вход', next, error, email });
  if (isLocked(email)) return fail(429, 'Слишком много неудачных попыток входа в этот аккаунт. Попробуйте через 15 минут.');
  const user = db.get('SELECT * FROM users WHERE email = ?', email);
  const ok = bcrypt.compareSync(String(req.body.password || '').slice(0, 200), user?.password_hash || DUMMY_HASH);
  if (!user || !user.password_hash || !ok) {
    registerFailure(email);
    return fail(400, 'Неверный email или пароль.');
  }
  if (user.banned) return fail(403, 'Аккаунт заблокирован.');
  clearFailures(email);
  startSession(req, user.id);
  res.redirect(next);
});

router.get('/register', (req, res) => res.render('register', { title: 'Регистрация', error: null, form: {} }));

router.post('/register', registerLimit, (req, res) => {
  const form = { email: String(req.body.email || '').trim().toLowerCase(), username: String(req.body.username || '').trim() };
  const password = String(req.body.password || '');
  let error = null;
  form.email = form.email.slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) error = 'Укажите корректный email.';
  else if (form.username.length < 2 || form.username.length > 32) error = 'Имя должно быть от 2 до 32 символов.';
  else if (password.length < 8 || password.length > 200) error = 'Пароль должен быть от 8 до 200 символов.';
  else if (/^(\d+|(.)\2+)$/.test(password) || /^(password|qwerty|12345678)/i.test(password)) error = 'Пароль слишком простой.';
  else if (db.get('SELECT 1 FROM users WHERE email = ?', form.email)) error = 'Этот email уже зарегистрирован.';
  if (error) return res.status(400).render('register', { title: 'Регистрация', error, form });

  const { lastInsertRowid } = db.run('INSERT INTO users (email, username, password_hash, role) VALUES (?, ?, ?, ?)',
    form.email, form.username, bcrypt.hashSync(password, 10), roleFor({ email: form.email }));
  startSession(req, Number(lastInsertRowid));
  req.flash('success', 'Добро пожаловать! Теперь вы можете добавлять каналы.');
  res.redirect('/account');
});

router.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

// Вход через виджет Telegram (нужны TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME).
// Если пользователь уже вошёл по email — Telegram привязывается к его аккаунту.
router.get('/auth/telegram', rateLimit('tg-auth', { max: 30, windowMs: 15 * 60_000 }), (req, res) => {
  // state выдаётся виджету на нашей странице и хранится в сессии. Без него чужая ссылка с данными
  // Telegram злоумышленника могла бы привязать его Telegram к аккаунту жертвы.
  const state = req.session.tgState;
  if (!state || !tokensEqual(req.query.state, state)) {
    req.flash('error', 'Ссылка входа устарела. Нажмите кнопку «Войти через Telegram» ещё раз.');
    return res.redirect('/login');
  }
  req.session.tgState = null;
  if (!checkTelegramAuth(req.query)) {
    req.flash('error', 'Не удалось подтвердить вход через Telegram. Попробуйте ещё раз.');
    return res.redirect('/login');
  }
  const tgId = Number(req.query.id);
  const tgUsername = req.query.username || null;
  const photo = /^https:\/\//.test(req.query.photo_url || '') ? req.query.photo_url : null;
  const existing = db.get('SELECT * FROM users WHERE telegram_id = ?', tgId);

  if (req.user) {
    if (existing && existing.id !== req.user.id) {
      req.flash('error', 'Этот Telegram уже привязан к другому аккаунту.');
      return res.redirect('/account');
    }
    db.run('UPDATE users SET telegram_id = ?, tg_username = ?, photo_url = ? WHERE id = ?', tgId, tgUsername, photo, req.user.id);
    if (config.adminTelegramIds.includes(tgId)) db.run(`UPDATE users SET role = 'admin' WHERE id = ?`, req.user.id);
    req.flash('success', 'Telegram привязан к аккаунту.');
    return res.redirect(safeNext(req.query.next) === '/' ? '/account' : safeNext(req.query.next));
  }

  let user = existing;
  if (!user) {
    const name = tgUsername || [req.query.first_name, req.query.last_name].filter(Boolean).join(' ').slice(0, 32) || 'user' + tgId;
    const { lastInsertRowid } = db.run('INSERT INTO users (username, telegram_id, tg_username, photo_url, role) VALUES (?, ?, ?, ?, ?)',
      name, tgId, tgUsername, photo, roleFor({ telegramId: tgId }));
    user = db.get('SELECT * FROM users WHERE id = ?', lastInsertRowid);
  } else {
    db.run('UPDATE users SET tg_username = ?, photo_url = COALESCE(?, photo_url) WHERE id = ?', tgUsername, photo, user.id);
    if (config.adminTelegramIds.includes(tgId) && user.role !== 'admin') db.run(`UPDATE users SET role = 'admin' WHERE id = ?`, user.id);
  }
  if (user.banned) { req.flash('error', 'Аккаунт заблокирован.'); return res.redirect('/login'); }
  startSession(req, user.id);
  res.redirect(safeNext(req.query.next) === '/' ? '/account' : safeNext(req.query.next));
});

module.exports = router;
module.exports.roleFor = roleFor;
