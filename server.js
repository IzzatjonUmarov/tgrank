const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const config = require('./src/config');
const db = require('./src/db');
const { updateAll } = require('./src/stats');
const social = require('./src/social');
const security = require('./src/security');
const i18n = require('./src/i18n');
const bot = require('./src/bot');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Без надёжного секрета подпись cookie сессии можно подделать
if (config.baseUrl.startsWith('https://') && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('SESSION_SECRET не задан или короче 32 символов — запуск остановлен.');
  process.exit(1);
}

app.use(security.headers);

// Версия статики меняется при каждом изменении файлов: браузер сразу получает свежие стили и скрипты
const assetVersion = crypto.createHash('md5')
  .update(['style.css', 'app.js'].map((f) => require('node:fs').readFileSync(path.join(__dirname, 'public', f))).join(''))
  .digest('hex').slice(0, 10);
app.locals.assetVersion = assetVersion;
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

// Служебная проверка для пинга и мониторинга: без сессии, не считается просмотром
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, uptime: Math.round(process.uptime()) });
});
app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 2000 }));
app.use(express.json({ limit: '50kb' }));

// Обновления от Telegram для бота: без сессии и CSRF, проверяется секретный заголовок
app.post('/bot/webhook', bot.webhookHandler);
app.use(cookieSession({
  name: 'tgr',
  secret: config.sessionSecret,
  maxAge: 30 * 24 * 3600 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: config.baseUrl.startsWith('https'),
}));

app.use(i18n.middleware);

// Текущий пользователь, CSRF-токен, flash-сообщения, хелперы для шаблонов
app.use((req, res, next) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  req.user = req.session.uid ? db.get('SELECT * FROM users WHERE id = ? AND banned = 0', req.session.uid) : null;
  if (req.session.uid && !req.user) req.session.uid = null;

  res.locals.user = req.user;
  res.locals.unread = req.user ? { messages: social.unreadMessages(req.user.id), orders: social.ordersNeedingAction(req.user.id) } : null;
  res.locals.csrf = req.session.csrf;
  res.locals.flash = req.session.flash || null;
  req.session.flash = null;
  res.locals.config = config;
  res.locals.path = req.path;
  res.locals.query = req.query;
  res.locals.categories = db.all('SELECT * FROM categories ORDER BY sort, name');
  res.locals.h = require('./src/helpers').forLang(req.t);
  req.flash = (type, text) => { req.session.flash = { type, text }; };
  // Метка state для виджета входа Telegram (создаётся, только если кнопка показана)
  res.locals.tgState = () => (req.session.tgState ||= crypto.randomBytes(16).toString('hex'));
  next();
});

app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path.startsWith('/api/')) return next();
  const token = req.body?._csrf || req.get('x-csrf-token');
  if (!security.tokensEqual(token, req.session.csrf)) return res.status(403).render('error', { title: 'Ошибка', message: 'Сессия устарела, обновите страницу и попробуйте снова.' });
  next();
});

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/public'));
app.use(require('./src/routes/users'));
app.use('/messages', require('./src/routes/messages'));
app.use('/orders', require('./src/routes/orders'));
app.use('/account', require('./src/routes/account'));
app.use('/admin', require('./src/routes/admin'));
app.use('/api', require('./src/routes/api'));

app.use((req, res) => res.status(404).render('error', { title: 'Не найдено', message: 'Страница не найдена.' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Ошибка', message: 'Что-то пошло не так. Попробуйте позже.' });
});

if (require.main === module) {
  app.listen(config.port, () => console.log(`${config.siteName} запущен на порту ${config.port}, BASE_URL=${config.baseUrl}`));
  if (process.env.DISABLE_IMPORT !== '1') {
    const importer = require('./src/importer');
    if (config.region === 'uz') require('./src/region').cleanupOnStart();
    if (config.starterList) importer.enqueueStarterList();
    importer.runWorker();
  }
  bot.start();
  if (config.keepAlive) {
    const ping = () => fetch(`${config.baseUrl}/healthz`, { signal: AbortSignal.timeout(30_000) })
      .catch((e) => console.error('[keep-alive]', e.message));
    setInterval(ping, config.keepAliveMinutes * 60_000);
    console.log(`[keep-alive] пинг ${config.baseUrl}/healthz каждые ${config.keepAliveMinutes} мин.`);
  }
  if (config.statsIntervalHours > 0 && process.env.DISABLE_STATS !== '1') {
    setTimeout(() => updateAll(), 60 * 1000);
    setInterval(() => updateAll(), config.statsIntervalHours * 3600 * 1000);
  }
}

module.exports = app;
