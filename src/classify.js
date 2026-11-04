// Простое автоопределение категории и языка по названию и описанию канала
const db = require('./db');

const KEYWORDS = {
  news: ['новост', 'news', 'yangilik', 'хабар', 'xabar', 'срочно', 'breaking', 'сми', 'газета', 'gazeta', 'tv', 'тв', 'радио'],
  crypto: ['crypto', 'крипт', 'bitcoin', 'биткоин', 'btc', 'ton', 'blockchain', 'блокчейн', 'nft', 'airdrop', 'defi', 'binance', 'токен', 'token', 'web3'],
  economy: ['экономик', 'финанс', 'инвест', 'акци', 'биржа', 'рынок', 'trading', 'трейд', 'invest', 'stock', 'forex', 'iqtisod', 'moliya', 'банк', 'bank'],
  business: ['бизнес', 'business', 'стартап', 'startup', 'предпринимат', 'tadbirkor', 'biznes'],
  marketing: ['маркетинг', 'marketing', 'smm', 'реклам', 'reklama', 'pr ', 'таргет', 'seo'],
  tech: ['tech', 'техн', 'it ', 'программ', 'python', 'javascript', 'developer', 'разработ', 'код', 'code', 'gadget', 'гаджет', 'android', 'iphone', 'apple', 'ai ', 'нейросет', 'linux', 'devops', 'dasturlash'],
  education: ['образован', 'обучен', 'курс', 'school', 'школ', 'универс', 'ta\'lim', 'talim', 'education', 'learn', 'урок', 'dars', 'репетитор', 'olimpiada'],
  languages: ['english', 'английск', 'ingliz', 'ielts', 'toefl', 'немецк', 'корейск', 'korean', 'arab', 'язык', 'tili'],
  entertainment: ['юмор', 'мем', 'meme', 'funny', 'прикол', 'smeshn', 'kulgi', 'hazil', 'развлеч', 'анекдот'],
  music: ['music', 'музык', 'musiqa', 'песн', 'qo\'shiq', 'mp3', 'rap', 'рэп', 'remix'],
  movies: ['кино', 'фильм', 'сериал', 'movie', 'film', 'serial', 'kino', 'netflix', 'аниме', 'anime'],
  games: ['игр', 'game', 'gaming', 'pubg', 'minecraft', 'cs2', 'dota', 'steam', "o'yin", 'киберспорт'],
  sport: ['спорт', 'sport', 'футбол', 'football', 'futbol', 'ufc', 'mma', 'бокс', 'nba', 'chempionat', 'championat'],
  health: ['здоров', 'health', 'фитнес', 'fitness', 'медицин', 'врач', 'диет', 'salomatlik', 'shifokor'],
  psychology: ['психолог', 'psycholog', 'мотивац', 'motivat', 'саморазвит', 'отношени'],
  travel: ['путешеств', 'travel', 'туризм', 'tour', 'sayohat', 'виза', 'visa', 'авиабилет'],
  food: ['рецепт', 'recipe', 'кулинар', 'еда', 'food', 'cook', 'retsept', 'ovqat', 'taom'],
  fashion: ['мода', 'fashion', 'красот', 'beauty', 'стиль', 'макияж', "go'zallik", 'одежд'],
  auto: ['авто', 'auto', 'car', 'машин', 'mashina', 'мото', 'chevrolet', 'byd', 'tesla'],
  design: ['дизайн', 'design', 'figma', 'ui', 'ux', 'иллюстрац', 'art', 'арт'],
  books: ['книг', 'book', 'kitob', 'литератур', 'чтени', 'аудиокниг'],
  jobs: ['ваканс', 'работа', 'job', 'vacancy', 'ish ', 'ishga', 'hr', 'резюме', 'фриланс', 'freelance', 'remote'],
  shopping: ['скидк', 'sale', 'aliexpress', 'wildberries', 'ozon', 'chegirma', 'акция', 'купон', 'промокод', 'магазин', "do'kon", 'uzum'],
  politics: ['полит', 'politic', 'siyosat', 'выбор', 'депутат', 'кремл', 'kremlin'],
  religion: ['ислам', 'islam', 'намаз', 'quran', 'коран', 'dua', 'дуа', 'hadis', 'хадис', 'православ', 'церк', 'церков'],
  regional: ['ташкент', 'toshkent', 'tashkent', 'самарканд', 'samarqand', 'бухар', 'buxoro', 'фергана', "farg'ona", 'андижан', 'андижон', 'наманган', 'москв', 'питер', 'алмат', 'город'],
  blogs: ['блог', 'blog', 'личный', 'мысли', 'дневник', 'автор'],
};

function guessCategoryId(info) {
  const text = ` ${info.title} ${info.description} ${info.username} `.toLowerCase();
  if (info.type === 'bot') return categoryId('bots');
  let best = null, bestScore = 0;
  for (const [slug, words] of Object.entries(KEYWORDS)) {
    const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
    if (score > bestScore) { best = slug; bestScore = score; }
  }
  return categoryId(best || 'other');
}

function categoryId(slug) {
  return db.get('SELECT id FROM categories WHERE slug = ?', slug)?.id ?? db.get(`SELECT id FROM categories WHERE slug = 'other'`)?.id ?? null;
}

function guessLanguage(info) {
  const text = `${info.title} ${info.description}`;
  if (/[ўқғҳ]/i.test(text) || /\b(va|uchun|bilan|haqida|yangilik\w*|rasmiy|xabar\w*|kanali?|bo'yicha)\b|[oOgG][ʻ'‘`]/i.test(text)) return 'uz';
  if (/[әңөұүһ]/i.test(text)) return 'kk';
  if (/[іїєґ]/i.test(text)) return 'uk';
  if (/[а-яё]/i.test(text)) return 'ru';
  if (/[a-z]/i.test(text)) return 'en';
  return 'other';
}

// Канал для узбекского рынка: узбекский язык или явная привязка к Узбекистану
// (страна, города, домены .uz, телефоны +998, сум, «uz» в username).
// Русскоязычные узбекские каналы (Kun.uz, Gazeta.uz и т. п.) тоже проходят.
const UZ_WORDS = [
  'узбекистан', 'ўзбекистон', 'узбекистон', "o'zbekiston", 'oʻzbekiston', 'ozbekiston', 'uzbekistan', 'uzbek', 'узбек', "o'zbek", 'oʻzbek',
  'ташкент', 'тошкент', 'toshkent', 'tashkent', 'самарканд', 'самарқанд', 'samarqand', 'samarkand', 'бухар', 'buxoro', 'bukhara',
  'андижан', 'андижон', 'andijon', 'andijan', 'фергана', 'фарғона', "farg'ona", 'fargʻona', 'fergana', 'наманган', 'namangan',
  'нукус', 'nukus', 'каракалпак', 'қорақалпоқ', "qoraqalpog'", 'qoraqalpogʻ', 'карши', 'қарши', 'qarshi', 'хорезм', 'хоразм', 'xorazm',
  'ургенч', 'urganch', 'джизак', 'жиззах', 'jizzax', 'навои', 'навоий', 'navoiy', 'термез', 'термиз', 'termiz', 'гулистан', 'guliston',
  'кашкадар', 'қашқадарё', 'qashqadaryo', 'сурхандар', 'сурхондарё', 'surxondaryo', 'сырдар', 'sirdaryo', 'ферган', 'коканд', "qo'qon",
  'mirziyoyev', 'мирзиёев', 'uzcard', 'humo', 'payme', 'click.uz', 'uzum', '+998', ' uzs', "so'm", 'soʻm', ' сум ', ' сўм',
];

function isUzbekMarket(info, postsText = '') {
  if (guessLanguage(info) === 'uz') return { ok: true, reason: 'узбекский язык' };
  const profile = ` ${info.title} ${info.description} `.toLowerCase();
  if (/\.uz\b/.test(profile)) return { ok: true, reason: 'домен .uz' };
  if (/(^uz|uz$|_uz|uz_|uzb)/i.test(info.username)) return { ok: true, reason: 'uz в username' };
  const word = UZ_WORDS.find((w) => profile.includes(w));
  if (word) return { ok: true, reason: `«${word.trim()}» в описании` };
  if (postsText) {
    const text = ` ${postsText} `.toLowerCase();
    if (guessLanguage({ title: '', description: postsText }) === 'uz') return { ok: true, reason: 'посты на узбекском' };
    const hits = UZ_WORDS.filter((w) => text.includes(w)).length + (text.match(/\.uz\b/g) || []).length;
    if (hits >= 3) return { ok: true, reason: 'посты про Узбекистан' };
  }
  return { ok: false, reason: 'нет признаков узбекского рынка' };
}

module.exports = { guessCategoryId, guessLanguage, isUzbekMarket };
