// Начальные категории. С флагом --demo добавляет демо-каналы с историей подписчиков.
const db = require('./db');

const CATEGORIES = [
  ['news', 'Новости и СМИ', '📰'], ['blogs', 'Блоги', '✍️'], ['tech', 'Технологии', '💻'],
  ['crypto', 'Криптовалюты', '₿'], ['business', 'Бизнес и стартапы', '💼'], ['economy', 'Экономика и финансы', '📈'],
  ['marketing', 'Маркетинг и PR', '📣'], ['education', 'Образование', '🎓'], ['languages', 'Иностранные языки', '🗣️'],
  ['entertainment', 'Юмор и развлечения', '😂'], ['music', 'Музыка', '🎵'], ['movies', 'Кино и сериалы', '🎬'],
  ['games', 'Игры', '🎮'], ['sport', 'Спорт', '⚽'], ['health', 'Здоровье и фитнес', '💪'],
  ['psychology', 'Психология', '🧠'], ['travel', 'Путешествия', '✈️'], ['food', 'Еда и кулинария', '🍳'],
  ['fashion', 'Мода и красота', '👗'], ['auto', 'Авто и мото', '🚗'], ['design', 'Дизайн', '🎨'],
  ['books', 'Книги', '📚'], ['jobs', 'Работа и вакансии', '🧑‍💼'], ['shopping', 'Скидки и покупки', '🛍️'],
  ['politics', 'Политика', '🏛️'], ['religion', 'Религия', '🕌'], ['regional', 'Региональные', '📍'],
  ['bots', 'Полезные боты', '🤖'], ['other', 'Другое', '📁'],
];

db.tx(() => {
  CATEGORIES.forEach(([slug, name, icon], i) =>
    db.run('INSERT INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING', slug, name, icon, i));
});
console.log(`Категорий: ${db.get('SELECT COUNT(*) AS n FROM categories').n}`);

if (process.argv.includes('--demo')) {
  const DEMO = [
    ['durov', 'channel', 'Durov\'s Channel', 'blogs', 'en'], ['telegram', 'channel', 'Telegram News', 'news', 'en'],
    ['tginfo', 'channel', 'Tginfo', 'tech', 'ru'], ['rian_ru', 'channel', 'РИА Новости', 'news', 'ru'],
    ['kunuzofficial', 'channel', 'Kun.uz', 'news', 'uz'], ['daryo', 'channel', 'Daryo', 'news', 'uz'],
    ['habr_com', 'channel', 'Хабр', 'tech', 'ru'], ['vcru', 'channel', 'vc.ru', 'business', 'ru'],
    ['binance_announcements', 'channel', 'Binance Announcements', 'crypto', 'en'], ['tonblockchain', 'channel', 'TON Community', 'crypto', 'en'],
    ['englishdom', 'channel', 'EnglishDom', 'languages', 'ru'], ['kinopoisk', 'channel', 'Кинопоиск', 'movies', 'ru'],
    ['python_ru', 'group', 'Python Russian', 'tech', 'ru'], ['javascript_ru', 'group', 'JavaScript Russian', 'tech', 'ru'],
    ['uzbekistan_it', 'group', 'IT Uzbekistan', 'tech', 'uz'], ['crypto_chat', 'group', 'Crypto Chat', 'crypto', 'ru'],
    ['BotFather', 'bot', 'BotFather', 'bots', 'en'], ['gif', 'bot', 'GIF Search', 'bots', 'en'],
    ['wallet', 'bot', 'Wallet', 'crypto', 'en'], ['vote', 'bot', 'Vote Bot', 'bots', 'en'],
  ];
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
  db.tx(() => {
    for (const [username, type, title, cat, lang] of DEMO) {
      if (db.get('SELECT 1 FROM channels WHERE username = ?', username)) continue;
      let subs = rnd(5_000, 3_000_000);
      const catId = db.get('SELECT id FROM categories WHERE slug = ?', cat).id;
      const { lastInsertRowid: id } = db.run(`INSERT INTO channels (username, type, title, description, category_id, language, subscribers, status, approved_at, votes, views)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now', ?), ?, ?)`,
        username, type, title, `Демо-описание для ${title}. Данные обновятся при первой синхронизации с Telegram.`,
        catId, lang, subs, `-${rnd(0, 60)} day`, rnd(0, 500), rnd(0, 5000));
      const trend = (Math.random() - 0.3) * 0.004;
      for (let d = 90; d >= 0; d--) {
        db.run('INSERT OR REPLACE INTO stats (channel_id, date, subscribers) VALUES (?, date(\'now\', ?), ?)', id, `-${d} day`, subs);
        subs = Math.max(100, Math.round(subs * (1 + trend + (Math.random() - 0.5) * 0.003)));
      }
      db.run('UPDATE channels SET subscribers = (SELECT subscribers FROM stats WHERE channel_id = ? ORDER BY date DESC LIMIT 1) WHERE id = ?', id, id);
    }
    db.run(`UPDATE channels SET boost_until = datetime('now', '+20 hours'), last_boost_at = datetime('now') WHERE username IN ('tginfo', 'kunuzofficial', 'python_ru')`);
  });
  console.log(`Демо-каналов: ${db.get('SELECT COUNT(*) AS n FROM channels').n}`);
}
