const path = require('node:path');

module.exports = {
  port: Number(process.env.PORT || 3000),
  siteName: process.env.SITE_NAME || 'TgRank',
  // На Render адрес сервиса приходит в RENDER_EXTERNAL_URL автоматически
  baseUrl: (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tgrank.db'),
  sessionSecret: process.env.SESSION_SECRET || 'change-me-in-production',
  // Этап 1: все платные функции бесплатны. Выключите, когда подключите оплату.
  freeMode: process.env.FREE_MODE !== 'false',
  // Необязательно: токен бота для точного числа подписчиков и вход через Telegram
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  // Первый зарегистрированный с этим email получает роль admin
  adminEmail: (process.env.ADMIN_EMAIL || '').toLowerCase(),
  // Надёжный способ назначить админов: числовые Telegram ID через запятую (личность подтверждает Telegram).
  // Если задан, ADMIN_EMAIL игнорируется: email на сайте не подтверждается.
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(/[\s,]+/).filter(Boolean).map(Number),
  statsIntervalHours: Number(process.env.STATS_INTERVAL_HOURS || 6),
  boostHours: 24,
  boostCooldownHours: 24,
  perPage: 24,
};

Object.assign(module.exports, {
  // Автопоиск: каналы, упомянутые или репостнутые в постах, попадают в очередь импорта
  discovery: process.env.DISCOVERY !== 'false',
  discoveryMinSubscribers: Number(process.env.DISCOVERY_MIN_SUBSCRIBERS || 1000),
  autoApproveDiscovered: process.env.AUTO_APPROVE_DISCOVERED !== 'false',
  discoveryQueueLimit: Number(process.env.DISCOVERY_QUEUE_LIMIT || 20000),
  // Сколько страниц истории (по ~20 постов) паук листает у каждого канала
  crawlMaxPages: Number(process.env.CRAWL_MAX_PAGES || 50),
  // Загружать стартовый список популярных каналов (src/starter-channels.txt)
  starterList: process.env.STARTER_LIST !== 'false',
});

Object.assign(module.exports, {
  // Самопинг, чтобы бесплатный хостинг не усыплял сервер (Render засыпает через 15 минут без запросов).
  // Включается, если известен публичный адрес; KEEP_ALIVE=false — выключить.
  keepAlive: process.env.KEEP_ALIVE !== 'false' && module.exports.baseUrl.startsWith('https://'),
  keepAliveMinutes: Number(process.env.KEEP_ALIVE_MINUTES || 10),
});

Object.assign(module.exports, {
  // Регион каталога: uz — только каналы для узбекского рынка; all — без ограничений
  region: process.env.REGION || 'uz',
  // Курс для сравнения цен на рекламу в долларах и сумах (сортировка, CPM)
  usdUzs: Number(process.env.USD_UZS || 12800),
});
