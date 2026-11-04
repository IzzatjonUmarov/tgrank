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

async function fetchPage(username) {
  const res = await fetch(`https://t.me/${username}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TgRankBot/1.0)', 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`t.me ответил ${res.status}`);
  const html = await res.text();
  const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };

  const title = decodeEntities(pick(/<div class="tgme_page_title"[^>]*>([\s\S]*?)<\/div>/));
  if (!title) return null; // нет такого публичного username
  const description = decodeEntities(pick(/<div class="tgme_page_description[^"]*"[^>]*>([\s\S]*?)<\/div>/));
  const extra = decodeEntities(pick(/<div class="tgme_page_extra">([\s\S]*?)<\/div>/));
  const avatar = pick(/<img class="tgme_page_photo_image" src="([^"]+)"/);
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

async function fetchChannelInfo(username) {
  const info = await fetchPage(username);
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
function checkTelegramAuth(data) {
  if (!config.botToken || !data || !data.hash) return false;
  const { hash, ...rest } = data;
  const checkString = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(config.botToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  const fresh = Date.now() / 1000 - Number(rest.auth_date) < 86400;
  return fresh && hmac.length === hash.length && crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
}

module.exports = { parseUsername, fetchChannelInfo, checkTelegramAuth, parseCount };
