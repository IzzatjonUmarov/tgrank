// Защита: заголовки безопасности, ограничение частоты запросов, безопасные редиректы, CSRF
const crypto = require('node:crypto');
const config = require('./config');

const HTTPS = config.baseUrl.startsWith('https://');

// Заголовки безопасности и Content-Security-Policy.
// Скрипты — только свои и виджет входа Telegram; встраивание сайта в чужие страницы запрещено.
function headers(req, res, next) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "frame-src https://oauth.telegram.org",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(HTTPS ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  res.set({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  });
  if (HTTPS) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // Личные страницы не кэшируются прокси и браузером
  if (req.session?.uid) res.set('Cache-Control', 'private, no-store');
  next();
}

// Простой ограничитель частоты в памяти (одного процесса достаточно для одного сервера).
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k);
}, 60_000).unref();

function hit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count++;
  return { ok: b.count <= max, retryAfter: Math.ceil((b.reset - now) / 1000) };
}

// rateLimit('login', { max: 10, windowMs: 15 * 60_000 }) — по IP и, если вошёл, по пользователю
function rateLimit(name, { max, windowMs, by = 'ip' }) {
  return (req, res, next) => {
    const who = by === 'user' && req.user ? `u${req.user.id}` : `ip${req.ip}`;
    const r = hit(`${name}:${who}`, max, windowMs);
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfter));
    const msg = `Слишком много попыток. Повторите через ${Math.ceil(r.retryAfter / 60)} мин.`;
    if (req.path.startsWith('/api/') || req.get('x-requested-with') === 'fetch' || req.accepts(['html', 'json']) === 'json') {
      return res.status(429).json({ error: msg });
    }
    res.status(429).render('error', { title: 'Слишком много запросов', message: msg });
  };
}

// Неудачные входы по email: блокируют подбор пароля к одному аккаунту с разных IP
function registerFailure(email) {
  return hit(`login-fail:${email}`, 8, 15 * 60_000);
}
function isLocked(email) {
  const b = buckets.get(`login-fail:${email}`);
  return b && b.reset > Date.now() && b.count >= 8;
}
function clearFailures(email) {
  buckets.delete(`login-fail:${email}`);
}

// Редирект только на свой путь: без //, без обратных слешей и управляющих символов
function safeNext(n) {
  return typeof n === 'string' && /^\/(?![/\\])[^\\\s\x00-\x1f]*$/.test(n) ? n : '/';
}

// Путь из заголовка Referer, только если он с нашего сайта
function sameOriginPath(referer, fallback) {
  try {
    const u = new URL(referer);
    const base = new URL(config.baseUrl);
    if (u.host !== base.host && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return fallback;
    return safeNext(u.pathname + u.search) === '/' && u.pathname !== '/' ? fallback : u.pathname + u.search;
  } catch {
    return fallback;
  }
}

function tokensEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

module.exports = { headers, rateLimit, registerFailure, isLocked, clearFailures, safeNext, sameOriginPath, tokensEqual };
