const config = require('./config');

function num(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}
function short(n) {
  n = Number(n || 0);
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.0', '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.0', '') + 'K';
  return String(n);
}
function delta(n) {
  n = Number(n || 0);
  if (n > 0) return `<span class="up">+${short(n)}</span>`;
  if (n < 0) return `<span class="down">−${short(-n)}</span>`;
  return '<span class="muted">0</span>';
}
const TYPES = { channel: 'Канал', group: 'Группа', bot: 'Бот' };
const TYPES_PLURAL = { channel: 'Каналы', group: 'Группы', bot: 'Боты' };
const LANGUAGES = { ru: 'Русский', uz: 'Oʻzbekcha', en: 'English', uk: 'Українська', kk: 'Қазақша', ky: 'Кыргызча', tg: 'Тоҷикӣ', az: 'Azərbaycan', other: 'Другой' };

function stars(avg) {
  const full = Math.round(Number(avg || 0));
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}
function date(s) {
  if (!s) return '—';
  return new Date(s.replace(' ', 'T') + (s.length <= 19 ? 'Z' : '')).toLocaleDateString('ru-RU');
}
function initials(title) {
  return String(title || '?').trim().charAt(0).toUpperCase();
}
function qs(query, patch) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...query, ...patch })) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
}
function avatarColor(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 50%)`;
}

module.exports = { num, short, delta, TYPES, TYPES_PLURAL, LANGUAGES, stars, date, initials, qs, avatarColor, config };
