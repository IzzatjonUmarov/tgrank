// Переводы интерфейса. Ключ — исходный русский текст, словари лежат в src/locales/<lang>.json.
// t('Удалено каналов: {n}.', { n: 5 }) — подстановка параметров в фигурных скобках.
const fs = require('node:fs');
const path = require('node:path');

const LANGS = { uz: 'Oʻzbekcha', ru: 'Русский' };
const DEFAULT_LANG = process.env.DEFAULT_LANG && LANGS[process.env.DEFAULT_LANG] ? process.env.DEFAULT_LANG : 'uz';

const dicts = {};
for (const lang of Object.keys(LANGS)) {
  const file = path.join(__dirname, 'locales', `${lang}.json`);
  dicts[lang] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function fill(str, params) {
  if (!params) return str;
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])));
}

function makeT(lang) {
  const dict = dicts[lang] || {};
  const t = (key, params) => {
    if (key === null || key === undefined) return '';
    const s = String(key);
    const tr = dict[s] ?? dict[s.trim()];
    return fill(tr !== undefined && tr !== '' ? tr : s, params);
  };
  return t;
}

// Язык запроса: ?lang= (запоминается в cookie), затем cookie, затем язык по умолчанию
function middleware(req, res, next) {
  let lang = req.query.lang;
  if (lang && LANGS[lang]) {
    res.cookie('lang', lang, { maxAge: 365 * 24 * 3600 * 1000, sameSite: 'lax', httpOnly: false });
  } else {
    const m = /(?:^|;\s*)lang=(\w+)/.exec(req.headers.cookie || '');
    lang = m && LANGS[m[1]] ? m[1] : DEFAULT_LANG;
  }
  req.lang = lang;
  req.t = makeT(lang);
  res.locals.lang = lang;
  res.locals.LANGS = LANGS;
  res.locals.t = req.t;
  next();
}

module.exports = { LANGS, DEFAULT_LANG, makeT, fill, middleware, dicts };
