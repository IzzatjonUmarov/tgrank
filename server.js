const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./src/config');
const db = require('./src/db');
const { updateAll } = require('./src/stats');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cookieSession({
  name: 'tgr',
  secret: config.sessionSecret,
  maxAge: 30 * 24 * 3600 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: config.baseUrl.startsWith('https'),
}));

// Текущий пользователь, CSRF-токен, flash-сообщения, хелперы для шаблонов
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  req.user = req.session.uid ? db.get('SELECT * FROM users WHERE id = ? AND banned = 0', req.session.uid) : null;
  if (req.session.uid && !req.user) req.session.uid = null;

  res.locals.user = req.user;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.config = config;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.categories = db.all('SELECT * FROM categories ORDER BY sort, name');
  res.locals.h = require('./src/helpers');
  req.flash = (type, text) => { req.session.flash = { type, text }; };
  next();
});

app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path.startsWith('/api/')) return next();
  const token = req.body?._csrf || req.get('x-csrf-token');
  if (token !== req.session.csrf) return res.status(403).render('error', { title: 'Ошибка', message: 'Сессия устарела, обновите страницу и попробуйте снова.' });
  next();
});

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/public'));
app.use('/account', require('./src/routes/account'));
app.use('/admin', require('./src/routes/admin'));
app.use('/api', require('./src/routes/api'));

app.use((req, res) => res.status(404).render('error', { title: 'Не найдено', message: 'Страница не найдена.' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Ошибка', message: 'Что-то пошло не так. Попробуйте позже.' });
});

if (require.main === module) {
  app.listen(config.port, () => console.log(`${config.siteName} запущен: ${config.baseUrl} (порт ${config.port})`));
  if (config.statsIntervalHours > 0 && process.env.DISABLE_STATS !== '1') {
    setTimeout(() => updateAll(), 60 * 1000);
    setInterval(() => updateAll(), config.statsIntervalHours * 3600 * 1000);
  }
}

module.exports = app;
