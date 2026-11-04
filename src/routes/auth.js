const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const { checkTelegramAuth } = require('../telegram');
const { safeNext } = require('./guards');

const router = express.Router();

function roleFor(email) {
  const noUsers = db.get('SELECT COUNT(*) AS n FROM users').n === 0;
  return (config.adminEmail && email === config.adminEmail) || (!config.adminEmail && noUsers) ? 'admin' : 'user';
}

router.get('/login', (req, res) => res.render('login', { title: 'Вход', next: safeNext(req.query.next), error: null, email: '' }));

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.get('SELECT * FROM users WHERE email = ?', email);
  const next = safeNext(req.body.next);
  if (!user || !user.password_hash || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    return res.status(400).render('login', { title: 'Вход', next, error: 'Неверный email или пароль.', email });
  }
  if (user.banned) return res.status(403).render('login', { title: 'Вход', next, error: 'Аккаунт заблокирован.', email });
  req.session.uid = user.id;
  res.redirect(next);
});

router.get('/register', (req, res) => res.render('register', { title: 'Регистрация', error: null, form: {} }));

router.post('/register', (req, res) => {
  const form = { email: String(req.body.email || '').trim().toLowerCase(), username: String(req.body.username || '').trim() };
  const password = String(req.body.password || '');
  let error = null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) error = 'Укажите корректный email.';
  else if (form.username.length < 2 || form.username.length > 32) error = 'Имя должно быть от 2 до 32 символов.';
  else if (password.length < 6) error = 'Пароль должен быть не короче 6 символов.';
  else if (db.get('SELECT 1 FROM users WHERE email = ?', form.email)) error = 'Этот email уже зарегистрирован.';
  if (error) return res.status(400).render('register', { title: 'Регистрация', error, form });

  const { lastInsertRowid } = db.run('INSERT INTO users (email, username, password_hash, role) VALUES (?, ?, ?, ?)',
    form.email, form.username, bcrypt.hashSync(password, 10), roleFor(form.email));
  req.session.uid = Number(lastInsertRowid);
  req.flash('success', 'Добро пожаловать! Теперь вы можете добавлять каналы.');
  res.redirect('/account');
});

router.post('/logout', (req, res) => { req.session = null; res.redirect('/'); });

// Вход через виджет Telegram (нужны TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME).
// Если пользователь уже вошёл по email — Telegram привязывается к его аккаунту.
router.get('/auth/telegram', (req, res) => {
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
    req.flash('success', 'Telegram привязан к аккаунту.');
    return res.redirect(safeNext(req.query.next) === '/' ? '/account' : safeNext(req.query.next));
  }

  let user = existing;
  if (!user) {
    const name = tgUsername || [req.query.first_name, req.query.last_name].filter(Boolean).join(' ').slice(0, 32) || 'user' + tgId;
    const { lastInsertRowid } = db.run('INSERT INTO users (username, telegram_id, tg_username, photo_url, role) VALUES (?, ?, ?, ?, ?)',
      name, tgId, tgUsername, photo, roleFor(''));
    user = db.get('SELECT * FROM users WHERE id = ?', lastInsertRowid);
  } else {
    db.run('UPDATE users SET tg_username = ?, photo_url = COALESCE(?, photo_url) WHERE id = ?', tgUsername, photo, user.id);
  }
  if (user.banned) { req.flash('error', 'Аккаунт заблокирован.'); return res.redirect('/login'); }
  req.session.uid = user.id;
  res.redirect(safeNext(req.query.next) === '/' ? '/account' : safeNext(req.query.next));
});

module.exports = router;
