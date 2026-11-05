// Получение публичной информации о канале/группе/боте.
// Источник 1: публичная страница t.me/<username> (без токена).
// Источник 2 (если задан TELEGRAM_BOT_TOKEN): Bot API getChat / getChatMemberCount.
const crypto = require('node:crypto');
const config = require('./config');

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;

function parseUsername(input) {
  if (!input) return null;
  let s = String(input).trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.(me|dog)\//i, '');
  s = s.replace(/^s\//, '').replace(/^@/, '').split(/[/?#]/)[0];
  return USERNAME_RE.test(s) ? s : null;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .trim();
}

function parseCount(text) {
  const m = String(text).match(/(\d[\d\s\u00a0.,]*)([KM])?(?![a-z])/i);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/[\s\u00a0,]/g, ''));
  if (/k/i.test(m[2] || '')) n *= 1e3;
  if (/m/i.test(m[2] || '')) n *= 1e6;
  return Math.round(n);
}

// Все запросы к t.me идут по одному с паузой, чтобы не получить блокировку.
// При ответе 429 очередь ставится на паузу.
const TME_INTERVAL_MS = Number(process.env.TME_INTERVAL_MS || 1500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Очередь запросов к t.me: по одному с паузой, при 429 — пауза минуту.
// Запросы пользователей (high) обгоняют фоновые: импорт, паук, обновление статистики.
const tmeQueue = { high: [], low: [] };
let tmeBusy = false;
let tmePauseUntil = 0;
let lastResponse = null; // для диагностики в админке

function tmeGet(path, { priority = 'low' } = {}) {
  return new Promise((resolve, reject) => {
    tmeQueue[priority === 'high' ? 'high' : 'low'].push({ path, resolve, reject });
    drain();
  });
}

async function drain() {
  if (tmeBusy) return;
  tmeBusy = true;
  try {
    let job;
    while ((job = tmeQueue.high.shift() || tmeQueue.low.shift())) {
      const wait = tmePauseUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const res = await fetch(`https://t.me/${job.path}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TgRank/1.0',
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(15000),
        });
        const html = res.ok ? await res.text() : '';
        lastResponse = { path: job.path, status: res.status, url: res.url, length: html.length, at: new Date().toISOString() };
        if (res.status === 429) {
          tmePauseUntil = Date.now() + 60_000;
          throw new Error('t.me: слишком много запросов, пауза 60 с');
        }
        if (!res.ok) throw new Error(`t.me ответил ${res.status}`);
        job.resolve(html);
      } catch (e) {
        job.reject(e);
      }
      await sleep(TME_INTERVAL_MS);
    }
  } finally {
    tmeBusy = false;
  }
}

function queueSize() {
  return { high: tmeQueue.high.length, low: tmeQueue.low.length, pausedFor: Math.max(0, tmePauseUntil - Date.now()), last: lastResponse };
}

// Профиль по username. Если на странице нет блока с названием (Telegram иногда отдаёт
// урезанную страницу при частых запросах), повторяем и пробуем веб-просмотр t.me/s/.
async function fetchPage(username, opts = {}) {
  let info = parsePage(await tmeGet(username, opts), username);
  if (info) return info;
  // Повтор — только для запросов пользователей, чтобы не тратить лимит на фоновые проверки
  if (opts.priority === 'high') {
    await sleep(3000);
    info = parsePage(await tmeGet(username, opts), username);
    if (info) return info;
  }
  info = parsePreview(await tmeGet(`s/${username}`, opts).catch(() => ''), username);
  if (!info) console.warn(`[t.me] не удалось разобрать профиль @${username}:`, JSON.stringify(lastResponse));
  return info;
}

// Пригласительная ссылка частного канала: t.me/+HASH или t.me/joinchat/HASH
function parseInvite(input) {
  const m = String(input || '').trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.(?:me|dog)\/(?:\+|joinchat\/)([\w-]{10,64})\/?$/i);
  return m ? `https://t.me/+${m[1]}` : null;
}

async function fetchInviteInfo(inviteLink, username, opts = {}) {
  const hash = parseInvite(inviteLink)?.split('+')[1];
  if (!hash) return null;
  const info = parsePage(await tmeGet(`+${hash}`, opts), username);
  if (info && info.type === 'user') info.type = 'channel';
  return info;
}

// Веб-просмотр канала t.me/s/<username>: есть только у публичных каналов
function parsePreview(html, username) {
  if (!html) return null;
  const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };
  const title = decodeEntities(pick(/<div class="tgme_channel_info_header_title"[^>]*>([\s\S]*?)<\/div>/));
  if (!title) return null;
  const counter = html.match(/<span class="counter_value">([^<]+)<\/span>\s*<span class="counter_type">(subscribers?|members?)<\/span>/i);
  return {
    username,
    title,
    description: decodeEntities(pick(/<div class="tgme_channel_info_description"[^>]*>([\s\S]*?)<\/div>/)),
    avatar_url: pick(/<i class="tgme_page_photo_image[^"]*"[^>]*>\s*<img src="([^"]+)"/) || null,
    type: counter && /member/i.test(counter[2]) ? 'group' : 'channel',
    subscribers: counter ? parseCount(counter[1]) : 0,
    tg_verified: /verified-icon/.test(html) ? 1 : 0,
  };
}

function parsePage(html, username) {
  const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };

  const meta = (name) => decodeEntities(pick(new RegExp(`<meta property="${name}" content="([^"]*)"`)));
  let title = decodeEntities(pick(/<div class="tgme_page_title"[^>]*>([\s\S]*?)<\/div>/));
  const extra = decodeEntities(pick(/<div class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/));
  // Запасной вариант — мета-теги og:*, но только если на странице есть счётчик подписчиков
  if (!title && extra) title = meta('og:title');
  if (!title || /^Telegram: (Contact|Join|View) @/i.test(title)) return null; // нет такого публичного username
  const description = decodeEntities(pick(/<div class="tgme_page_description[^"]*"[^>]*>([\s\S]*?)<\/div>/)) || meta('og:description');
  const avatar = pick(/<img class="tgme_page_photo_image" src="([^"]+)"/) || (title ? meta('og:image') : '');
  const verified = /verified-icon|tgme_page_title_verified/.test(html);

  let type = 'channel';
  if (/members?/i.test(extra)) type = 'group';
  else if (/subscribers?/i.test(extra)) type = 'channel';
  else if (/bot$/i.test(username) || /monthly users/i.test(extra)) type = 'bot';
  else if (/^@/.test(extra)) type = /bot$/i.test(username) ? 'bot' : 'user';

  const subscribers = (type === 'channel' || type === 'group' || type === 'bot') ? parseCount(extra.split(',')[0]) : 0;
  return { username, title, description, avatar_url: avatar || null, type, subscribers, tg_verified: verified ? 1 : 0 };
}

async function botApi(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || 'Bot API error');
  return data.result;
}

async function fetchChannelInfo(username, opts = {}) {
  const info = await fetchPage(username, opts);
  if (info && config.botToken && info.type !== 'bot' && info.type !== 'user') {
    try {
      info.subscribers = await botApi('getChatMemberCount', { chat_id: '@' + username });
      const chat = await botApi('getChat', { chat_id: '@' + username });
      if (chat.description) info.description = chat.description;
    } catch { /* остаёмся на данных со страницы */ }
  }
  return info;
}

// Проверка данных виджета "Войти через Telegram"
const TG_AUTH_FIELDS = ['id', 'first_name', 'last_name', 'username', 'photo_url', 'auth_date'];

function checkTelegramAuth(data) {
  if (!config.botToken || !data || !data.hash) return false;
  const hash = String(data.hash);
  // Подписываются только поля виджета: служебные параметры вроде ?link=1 в проверку не входят
  const rest = Object.fromEntries(TG_AUTH_FIELDS.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
  const checkString = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(config.botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  // Подпись живёт час: перехваченную ссылку входа нельзя использовать долго
  const age = Date.now() / 1000 - Number(rest.auth_date);
  const fresh = age >= -300 && age < 3600;
  return fresh && hmac.length === hash.length && crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
}

// Последние посты канала с публичной страницы t.me/s/<username>.
// Возвращает null, если у канала нет веб-превью (группы, боты, закрытые).
// before — листать историю: посты с номером меньше указанного
async function fetchPosts(username, before = null, opts = {}) {
  const html = await tmeGet(`s/${username}${before ? `?before=${before}` : ''}`, opts);
  if (!/tgme_widget_message_wrap/.test(html)) return null;

  const counter = html.match(/<span class="counter_value">([^<]+)<\/span>\s*<span class="counter_type">(subscribers?|members?)<\/span>/i);
  const subscribers = counter ? parseCount(counter[1]) : null;

  const posts = [];
  const texts = [];
  const mentions = new Set();
  const own = username.toLowerCase();
  for (const chunk of html.split('data-post="').slice(1)) {
    const id = chunk.match(/^[^/"]+\/(\d+)"/);
    if (!id) continue;
    const body = chunk.split('tgme_widget_message_wrap')[0];
    const viewsText = body.match(/<span class="tgme_widget_message_views">([^<]+)<\/span>/);
    const date = body.match(/<time datetime="([^"]+)"/);
    if (!viewsText || !date) continue; // служебные сообщения без просмотров

    let reactions = 0;
    for (const m of body.matchAll(/<span class="tgme_reaction[^"]*">([\s\S]*?)<\/span>/g)) {
      reactions += parseCount(decodeEntities(m[1]).replace(/^\D+/, ''));
    }
    const fwd = body.match(/tgme_widget_message_forwarded_from_name"[^>]*href="https?:\/\/t\.me\/([a-zA-Z][\w]{3,31})/);
    for (const m of body.matchAll(/href="https?:\/\/t\.me\/(?:s\/)?([a-zA-Z][\w]{3,31})(?=["/?])/g)) mentions.add(m[1]);
    for (const m of body.matchAll(/(?:^|[\s>(])@([a-zA-Z][\w]{3,31})\b/g)) mentions.add(m[1]);

    const text = body.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (text) texts.push(decodeEntities(text[1]));
    posts.push({
      id: Number(id[1]),
      date: new Date(date[1]).toISOString(),
      views: parseCount(viewsText[1]),
      reactions,
      forwarded_from: fwd ? fwd[1] : null,
      has_media: /tgme_widget_message_(photo|video|document|roundvideo|voice)/.test(body) ? 1 : 0,
    });
    if (fwd) mentions.add(fwd[1]);
  }
  const reserved = new Set(['joinchat', 'addstickers', 'share', 'proxy', 'socks', 'iv', 'addtheme', 'setlanguage', 'contact', 'login', 'addemoji', 'boost', 'giftcode', 'invoice']);
  const found = [...mentions].filter((u) => u.toLowerCase() !== own && !reserved.has(u.toLowerCase()));
  return { subscribers, posts, mentions: found, text: texts.join('\n').slice(0, 20000) };
}

// Является ли пользователь Telegram создателем или админом канала (бот должен быть админом канала)
async function isChannelAdmin(username, telegramId) {
  if (!config.botToken) throw new Error('Бот не настроен');
  const m = await botApi('getChatMember', { chat_id: '@' + username, user_id: telegramId });
  return m.status === 'creator' || m.status === 'administrator';
}

module.exports = { botApi, isChannelAdmin, tmeGet, queueSize, parsePage, parsePreview, parseUsername, parseInvite, fetchInviteInfo, fetchChannelInfo, fetchPosts, checkTelegramAuth, parseCount };
