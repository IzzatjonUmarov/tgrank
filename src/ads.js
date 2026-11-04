// «Беру рекламу»: прайс владельца канала, контакт для связи и CPM для рекламодателей
const config = require('./config');

const CURRENCIES = { UZS: 'сум', USD: '$' };
const FORMATS = ['1/24', '2/48', '1/72', 'Без удаления', 'Репост', 'Закреп', 'Нативная интеграция', 'Сторис'];

// Контакт: @username или ссылка t.me
function parseContact(input) {
  const s = String(input || '').trim();
  const m = s.match(/^(?:@|(?:https?:\/\/)?(?:www\.)?t\.me\/)([a-zA-Z][\w]{3,31})\/?$/);
  return m ? `@${m[1]}` : null;
}

function parsePrices(body) {
  const formats = [].concat(body.ad_format || []);
  const prices = [].concat(body.ad_price || []);
  const out = [];
  formats.forEach((f, i) => {
    const format = String(f || '').trim().slice(0, 40);
    const price = Math.round(Number(String(prices[i] || '').replace(/[\s ,]/g, '')));
    if (format && price > 0 && price < 1e12) out.push({ format, price });
  });
  return out.slice(0, 8);
}

// Минимальная цена в сумах — для сортировки и CPM при разных валютах
function minPriceUzs(prices, currency) {
  if (!prices.length) return null;
  const min = Math.min(...prices.map((p) => p.price));
  return Math.round(currency === 'USD' ? min * config.usdUzs : min);
}

function fmtPrice(price, currency) {
  const n = Number(price).toLocaleString('ru-RU');
  return currency === 'USD' ? `$${n}` : `${n} сум`;
}

// Цена за 1000 просмотров по самой дешёвой позиции прайса, в сумах
function cpm(c) {
  if (!c.ads_enabled || !c.ad_min_price_uzs || !c.avg_reach) return null;
  return Math.round((c.ad_min_price_uzs / c.avg_reach) * 1000);
}

module.exports = { CURRENCIES, FORMATS, parseContact, parsePrices, minPriceUzs, fmtPrice, cpm };
