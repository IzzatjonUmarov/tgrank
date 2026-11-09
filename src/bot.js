// Telegram-бот проверки каналов: карточка с охватами и оценкой накрутки, инлайн-режим, /top.
// Работает через webhook (на https) или long polling (локально). Тот же бот, что для входа на сайт.
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');
const ch = require('./channels');
const ads = require('./ads');
const { makeT } = require('./i18n');
const { botApi, parseUsername, fetchChannelInfo, fetchPosts } = require('./telegram');
const { syncChannel } = require('./sync');
const { metricsFromPosts, fraudLevel } = require('./analysis');
const { isUzbekMarket } = require('./classify');
const { insertChannel } = require('./importer');

const HIGH = { priority: 'high' };
const STALE_HOURS = 6;
const CHECKS_PER_HOUR = 30;

const enabled = () => !!(config.botToken && config.botUsername);
const webhookSecret = () => crypto.createHmac('sha256', config.sessionSecret).update('bot-webhook').digest('hex').slice(0, 48);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (n) => Number(n || 0).toLocaleString('ru-RU');
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + num(Math.abs(n || 0));

// ---------- пользователи бота: язык и статистика
function botUser(from) {
  let u = db.get('SELECT * FROM bot_users WHERE chat_id = ?', from.id);
  if (!u) {
    const lang = /^ru|^uk|^be|^kk/.test(from.language_code || '') ? 'ru' : 'uz';
    db.run('INSERT INTO bot_users (chat_id, username, lang) VALUES (?, ?, ?)', from.id, from.username || null, lang);
    u = db.get('SELECT * FROM bot_users WHERE chat_id = ?', from.id);
  } else {
    db.run(`UPDATE bot_users SET username = ?, last_seen = datetime('now') WHERE chat_id = ?`, from.username || null, from.id);
  }
  return u;
}

const recent = new Map();
function allowCheck(chatId) {
  const now = Date.now();
  const list = (recent.get(chatId) || []).filter((t) => now - t < 3600_000);
  if (list.length >= CHECKS_PER_HOUR) return false;
  list.push(now); recent.set(chatId, list);
  return true;
}

// ---------- проверка канала
function isStale(c) {
  return !c.last_checked_at || Date.now() - Date.parse(c.last_checked_at.replace(' ', 'T') + 'Z') > STALE_HOURS * 3600_000;
}

// Возвращает { channel } из каталога или { temp } — разовый анализ канала вне каталога
async function checkChannel(username) {
  let c = ch.byUsername(username);
  if (c && c.status === 'approved') {
    if (isStale(c)) {
      const r = await syncChannel(c, HIGH).catch(() => null);
      c = r?.channel ? ch.byId(r.channel.id) : ch.byUsername(username) || c;
    }
    return { channel: c };
  }
  const info = await fetchChannelInfo(username, HIGH).catch(() => undefined);
  if (info === undefined) return { error: 'Не удалось получить данные из Telegram. Попробуйте через минуту.' };
  if (!info) return { error: 'Канал @{u} не найден. Проверьте ссылку: канал должен быть публичным.' };
  if (info.type === 'user') return { error: 'Это личный аккаунт, а не канал.' };
  const page = info.type === 'channel' ? await fetchPosts(username, null, HIGH).catch(() => null) : null;
  // Второй адрес канала: показываем карточку основного
  if (page?.canonical && page.canonical.toLowerCase() !== username.toLowerCase()) {
    const main = ch.byUsername(page.canonical);
    if (main && main.status === 'approved') return { channel: main };
    info.username = page.canonical;
    c = c || ch.byUsername(page.canonical);
  }
  const uz = isUzbekMarket(info, page?.text);
  // Узбекский канал выше порога сразу попадает в каталог — бот тоже наполняет базу
  if (!c && (config.region !== 'uz' || uz.ok) && (info.type === 'bot' || info.subscribers >= config.discoveryMinSubscribers)) {
    insertChannel(info, page, { uz: uz.ok });
    return { channel: ch.byUsername(username), added: true };
  }
  return { temp: { ...info, ...metricsFromPosts(info.subscribers, page?.posts || []), hasPosts: !!page?.posts?.length } };
}

// ---------- карточка канала
function card(res, t) {
  const c = res.channel;
  const d = c
    ? { title: c.title, username: c.username, type: c.type, subscribers: c.subscribers, avgReach: c.avg_reach, err: c.err, postsPerDay: c.posts_per_day,
        engagement: c.engagement, score: c.fraud_score, reasons: JSON.parse(c.fraud_reasons || '[]'), analyzed: !!c.analyzed_at }
    : { ...res.temp, score: res.temp.score, analyzed: true };
  const lines = [`<b>${esc(d.title)}</b> (@${esc(d.username)})`, ''];
  lines.push(`👥 ${t('Подписчики')}: <b>${num(d.subscribers)}</b>` + (c ? ` (${signed(c.growth_week)} / ${t('неделя')})` : ''));
  if (d.avgReach != null) lines.push(`👁 ${t('Средний охват поста')}: <b>${num(d.avgReach)}</b> · ERR <b>${d.err}%</b>`);
  if (d.postsPerDay != null) lines.push(`📝 ${t('Постов в день')}: ${d.postsPerDay}` + (d.engagement != null ? ` · ${t('Вовлечённость')} ${d.engagement}%` : ''));
  if (c) lines.push(`🏆 ${t('Место в рейтинге')}: #${ch.rankPosition(c)}`);
  if (d.type === 'channel' && d.avgReach == null) lines.push(`ℹ️ ${t('Охваты недоступны: у канала закрыт веб-просмотр постов.')}`);

  lines.push('');
  const level = fraudLevel(d.score || 0);
  if (!d.analyzed) lines.push(`⏳ ${t('Проверка на накрутку появится после первого анализа.')}`);
  else if (level.key === 'ok') lines.push(`✅ ${t('Признаков накрутки не найдено')}`);
  else {
    lines.push(`⚠️ <b>${t(level.label)}</b> — ${t('риск')} ${d.score}/100`);
    for (const r of d.reasons.slice(0, 3)) lines.push(`• ${esc(r.tpl ? t(r.tpl, r.params) : r.text)}`);
  }
  if (c && c.ads_enabled && c.owner_id) {
    const prices = JSON.parse(c.ad_prices || '[]');
    lines.push('', `💰 <b>${t('Беру рекламу')}</b>` + (prices.length ? ': ' + prices.slice(0, 3).map((p) => `${esc(p.format)} — ${ads.fmtPrice(p.price, c.ad_currency, t)}`).join(', ') : ''));
  }
  if (res.added) lines.push('', `🆕 ${t('Канал добавлен в каталог.')}`);
  if (!c) lines.push('', `<i>${t('Канала нет в каталоге: это разовая проверка без истории подписчиков.')}</i>`);

  const buttons = [];
  if (c) buttons.push([{ text: `🌐 ${t('Подробнее на сайте')}`, url: `${config.baseUrl}/c/${c.username}` }]);
  if (c && c.ads_enabled && c.owner_id) buttons.push([{ text: `📦 ${t('Заказать рекламу')}`, url: `${config.baseUrl}/orders/new?channel=${c.id}` }]);
  buttons.push([{ text: `↗️ ${t('Поделиться проверкой')}`, switch_inline_query: d.username }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

// ---------- ответы
const send = (chatId, text, extra = {}) =>
  botApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }).catch((e) => console.error('[bot]', e.message));

function helpText(t) {
  return [
    `👋 <b>${t('Привет! Я проверяю Telegram-каналы.')}</b>`,
    '',
    t('Пришлите ссылку на канал, @username или перешлите пост из канала — я покажу подписчиков, рост, охваты, ERR и проверю на накрутку.'),
    '',
    `/top — ${t('быстрее всех растут за неделю')}`,
    `/lang — ${t('язык')} (UZ / RU)`,
    '',
    `${t('В любом чате:')} <code>@${config.botUsername} kunuz</code>`,
    `🌐 ${config.baseUrl}`,
  ].join('\n');
}

function topText(t) {
  const items = ch.list({ sort: 'growth_week', type: 'channel', perPage: 10 }).items;
  if (!items.length) return t('Пока пусто.');
  return [`📈 <b>${t('Быстрее всех растут за неделю')}</b>`, '',
    ...items.map((c, i) => `${i + 1}. <a href="${config.baseUrl}/c/${c.username}">${esc(c.title)}</a> — ${num(c.subscribers)} (${signed(c.growth_week)})`)].join('\n');
}

function extractUsername(msg) {
  const fwd = msg.forward_origin?.chat || msg.forward_from_chat;
  if (fwd) return fwd.username ? { username: fwd.username } : { private: true };
  const text = String(msg.text || '').trim();
  const start = /^\/start\s+c_([a-zA-Z][\w]{3,31})$/.exec(text);
  if (start) return { username: start[1] };
  const link = /(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z][\w]{3,31})/i.exec(text) || /@([a-zA-Z][\w]{3,31})\b/.exec(text);
  if (link) return { username: link[1] };
  const plain = parseUsername(text);
  return plain ? { username: plain } : {};
}

async function onMessage(msg) {
  if (!msg.from || msg.chat.type !== 'private') return;
  const u = botUser(msg.from);
  const t = makeT(u.lang);
  const text = String(msg.text || '').trim();
  if (text === '/start' || text === '/help') return send(msg.chat.id, helpText(t));
  if (text === '/top') return send(msg.chat.id, topText(t));
  if (text === '/lang') {
    return send(msg.chat.id, t('Выберите язык:'), { reply_markup: { inline_keyboard: [[{ text: 'Oʻzbekcha', callback_data: 'lang:uz' }, { text: 'Русский', callback_data: 'lang:ru' }]] } });
  }
  const target = extractUsername(msg);
  if (target.private) return send(msg.chat.id, t('Это закрытый канал — Telegram не показывает его данные. Проверить можно только публичные каналы.'));
  if (!target.username) return send(msg.chat.id, t('Пришлите ссылку на канал, например https://t.me/kunuzofficial или @kunuzofficial.'));
  if (!allowCheck(msg.chat.id)) return send(msg.chat.id, t('Слишком много проверок за час. Попробуйте позже.'));

  botApi('sendChatAction', { chat_id: msg.chat.id, action: 'typing' }).catch(() => {});
  db.run('UPDATE bot_users SET checks = checks + 1 WHERE chat_id = ?', msg.from.id);
  const res = await checkChannel(target.username);
  if (res.error) return send(msg.chat.id, t(res.error, { u: target.username }));
  const out = card(res, t);
  return send(msg.chat.id, out.text, { reply_markup: out.reply_markup });
}

async function onCallback(q) {
  const u = botUser(q.from);
  if (/^lang:(uz|ru)$/.test(q.data || '')) {
    const lang = q.data.split(':')[1];
    db.run('UPDATE bot_users SET lang = ? WHERE chat_id = ?', lang, q.from.id);
    await botApi('answerCallbackQuery', { callback_query_id: q.id, text: lang === 'ru' ? 'Русский' : 'Oʻzbekcha' }).catch(() => {});
    return send(q.from.id, helpText(makeT(lang)));
  }
  return botApi('answerCallbackQuery', { callback_query_id: q.id }).catch(() => u);
}

// Инлайн-режим: только данные из каталога, без запросов к Telegram — ответ мгновенный
async function onInline(q) {
  const u = botUser(q.from);
  const t = makeT(u.lang);
  const query = String(q.query || '').trim().replace(/^@/, '').slice(0, 64);
  let items = [];
  if (query.length >= 2) {
    const exact = ch.byUsername(parseUsername(query) || '');
    items = exact && exact.status === 'approved' ? [exact] : ch.list({ q: query, sort: 'subscribers', perPage: 8 }).items;
  } else {
    items = ch.list({ sort: 'subscribers', perPage: 8 }).items;
  }
  const results = items.map((c) => {
    const out = card({ channel: c }, t);
    return {
      type: 'article',
      id: String(c.id),
      title: c.title,
      description: `👥 ${num(c.subscribers)}` + (c.err != null ? ` · ERR ${c.err}%` : '') + (c.fraud_score >= 25 ? ` · ⚠️ ${c.fraud_score}/100` : ''),
      thumbnail_url: c.avatar_url || undefined,
      input_message_content: { message_text: out.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      reply_markup: { inline_keyboard: out.reply_markup.inline_keyboard.filter((row) => !row[0].switch_inline_query) },
    };
  });
  return botApi('answerInlineQuery', { inline_query_id: q.id, results, cache_time: 300, is_personal: false }).catch((e) => console.error('[bot inline]', e.message));
}

async function handleUpdate(update) {
  try {
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
    else if (update.inline_query) await onInline(update.inline_query);
  } catch (e) {
    console.error('[bot]', e);
  }
}

// ---------- запуск
async function setCommands() {
  const cmds = (t) => [
    { command: 'top', description: t('быстрее всех растут за неделю') },
    { command: 'lang', description: t('язык') + ' (UZ / RU)' },
    { command: 'help', description: t('как пользоваться') },
  ];
  await botApi('setMyCommands', { commands: cmds(makeT('uz')) }).catch(() => {});
  await botApi('setMyCommands', { commands: cmds(makeT('ru')), language_code: 'ru' }).catch(() => {});
}

let polling = false;
async function poll() {
  polling = true;
  let offset = 0;
  await botApi('deleteWebhook', {}).catch(() => {});
  while (polling) {
    try {
      const updates = await botApi('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'inline_query'] });
      for (const u of updates) { offset = u.update_id + 1; handleUpdate(u); }
    } catch (e) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function start() {
  if (!enabled() || process.env.BOT_MODE === 'off') return;
  const mode = process.env.BOT_MODE || (config.baseUrl.startsWith('https://') ? 'webhook' : 'polling');
  await setCommands();
  if (mode === 'webhook') {
    await botApi('setWebhook', {
      url: `${config.baseUrl}/bot/webhook`,
      secret_token: webhookSecret(),
      allowed_updates: ['message', 'callback_query', 'inline_query'],
      drop_pending_updates: false,
    }).then(() => console.log('[bot] webhook установлен')).catch((e) => console.error('[bot] setWebhook:', e.message));
  } else {
    console.log('[bot] режим long polling');
    poll();
  }
}

// Приём обновлений от Telegram: только с секретным заголовком
function webhookHandler(req, res) {
  const got = String(req.get('x-telegram-bot-api-secret-token') || '');
  const want = webhookSecret();
  if (!enabled() || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(403);
  res.sendStatus(200); // отвечаем сразу, обработка идёт в фоне
  handleUpdate(req.body || {});
}

function botStats() {
  return db.get(`SELECT COUNT(*) AS users, COALESCE(SUM(checks), 0) AS checks,
    SUM(last_seen >= datetime('now', '-1 day')) AS active_day FROM bot_users`);
}

module.exports = { start, webhookHandler, handleUpdate, checkChannel, card, extractUsername, botStats, enabled };
