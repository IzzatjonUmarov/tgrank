const path = require('node:path');

module.exports = {
  port: Number(process.env.PORT || 3000),
  siteName: process.env.SITE_NAME || 'TgRank',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tgrank.db'),
  sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',
  // Этап 1: все платные функции бесплатны. Выключите, когда подключите оплату.
  freeMode: process.env.FREE_MODE !== 'false',
  // Необязательно: токен бота для точного числа подписчиков и вход через Telegram
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  // Первый зарегистрированный с этим email получает роль admin
  adminEmail: (process.env.ADMIN_EMAIL || '').toLowerCase(),
  statsIntervalHours: Number(process.env.STATS_INTERVAL_HOURS || 6),
  boostHours: 24,
  boostCooldownHours: 24,
  perPage: 24,
};
