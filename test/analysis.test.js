// Тест анализа, детектора накрутки и импорта без сети: fetch подменяется фикстурами t.me
const os = require('os'); const DIR = require('fs').mkdtempSync(os.tmpdir() + '/tgrank-test-');
process.env.DB_PATH = DIR + '/test.db';
process.env.TME_INTERVAL_MS = '0';

const R = require('path').join(__dirname, '..', 'src') + '/';

const page = (u, title, extra, desc = 'Новости Ташкента и Узбекистана') => `<div class="tgme_page_title" dir="auto"><span dir="auto">${title}</span></div>
<div class="tgme_page_extra">${extra}</div><div class="tgme_page_description" dir="auto">${desc}</div>
<img class="tgme_page_photo_image" src="https://cdn.example/${u}.jpg">`;
const post = (u, id, views, date, extra = '') => `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="${u}/${id}">
${extra}<div class="tgme_widget_message_text js-message_text">Текст <a href="https://t.me/newchan1">ссылка</a> и @newchan2, @ruchan</div>
<div class="tgme_widget_message_reactions"><span class="tgme_reaction"><i class="emoji"><b>👍</b></i>12</span><span class="tgme_reaction"><i class="emoji"><b>🔥</b></i>1.2K</span></div>
<div class="tgme_widget_message_info"><span class="tgme_widget_message_views">${views}</span><span class="copyonly">views</span>
<span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${u}/${id}"><time datetime="${date}" class="time">10:00</time></a></span></div></div></div>`;
const daysAgo = (d) => new Date(Date.now() - d * 86400e3).toISOString();

const pages = {
  'https://t.me/goodchan': page('goodchan', 'Good Channel', '120 345 subscribers'),
  'https://t.me/s/goodchan': `<span class="counter_value">120K</span> <span class="counter_type">subscribers</span>` +
    Array.from({ length: 15 }, (_, i) => post('goodchan', 100 + i, ['18.2K', '25K', '31.4K', '14K', '22.9K'][i % 5], daysAgo(15 - i))).join(''),
  'https://t.me/fakechan': page('fakechan', 'Fake Channel', '200 000 subscribers', 'Крипта airdrop для Узбекистана'),
  'https://t.me/s/fakechan': Array.from({ length: 12 }, (_, i) => post('fakechan', 10 + i, '1.5K', daysAgo(12 - i),
      i === 3 ? '<div class="tgme_widget_message_forwarded_from">Forwarded from <a class="tgme_widget_message_forwarded_from_name" href="https://t.me/fwdsource"><span>Src</span></a></div>' : '')).join('') + '<div class="tgme_widget_message_wrap">',
  'https://t.me/newchan1': page('newchan1', 'New One', '5 432 subscribers', 'Футбол Ташкента'),
  'https://t.me/newchan2': page('newchan2', 'Tiny', '120 subscribers'),
  'https://t.me/fwdsource': page('fwdsource', 'Source', '12 345 members, 100 online', 'Python dasturlash va IT yangiliklar'),
  'https://t.me/s/goodchan?before=100': '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="goodchan/50"><div class="tgme_widget_message_text">Eski post @deepchan</div><span class="tgme_widget_message_views">9K</span><time datetime="2026-01-01T10:00:00+00:00"></time></div></div>',
  'https://t.me/deepchan': page('deepchan', 'Deep', '8 000 subscribers', "Samarqand yangiliklari va e'lonlar"),
  'https://t.me/ruchan': page('ruchan', 'Russian News', '50 000 subscribers', 'Главные новости России'),
  'https://t.me/+PrivAteHash12345': page('x', 'Закрытый клуб', '3 210 subscribers', 'Закрытый канал для подписчиков из Самарканда'),
  'https://t.me/someuser': page('someuser', 'Some User', '@someuser'),
};
global.fetch = async (url) => {
  const body = pages[url];
  return { ok: !!body || url.includes('/s/'), status: body ? 200 : 404, text: async () => body || '' };
};

(async () => {
  require(R + 'seed.js');
  const db = require(R + 'db');
  const importer = require(R + 'importer');
  const { syncChannel } = require(R + 'sync');
  const assert = require('assert');

  console.log(importer.enqueue(['@goodchan', 't.me/fakechan', 'https://t.me/someuser', 'bad link!', '@goodchan']));
  while (await importer.processOne()) {}
  const ch = (u) => db.get('SELECT * FROM channels WHERE username = ?', u);

  const good = ch('goodchan'), fake = ch('fakechan');
  console.log('good:', good.subscribers, good.avg_reach, good.err, good.posts_per_day, good.engagement, good.fraud_score, good.language, good.category_id);
  console.log('fake:', fake.subscribers, fake.avg_reach, fake.err, fake.fraud_score, JSON.parse(fake.fraud_reasons).map((r) => r.text));
  assert.equal(good.subscribers, 120345);
  assert.ok(good.fraud_score < 25, 'чистый канал без подозрений');
  assert.ok(fake.fraud_score >= 50, 'низкий ERR + одинаковые просмотры');
  assert.equal(db.get(`SELECT COUNT(*) n FROM posts WHERE channel_id = ?`, good.id).n, 15);
  assert.equal(db.get(`SELECT reactions FROM posts WHERE channel_id = ? LIMIT 1`, good.id).reactions, 1212);

  console.log('queue:', db.all('SELECT username, source, status, error FROM import_queue'));
  assert.equal(ch('newchan1')?.status, 'approved', 'автопоиск добавил канал из ссылки');
  assert.ok(!ch('newchan2'), 'маленький канал пропущен');
  assert.equal(ch('fwdsource')?.type, 'group', 'источник репоста найден');
  assert.ok(!ch('someuser'), 'личный аккаунт не добавлен');
  assert.ok(!ch('ruchan'), 'российский канал не прошёл фильтр Узбекистана');
  assert.equal(db.get(`SELECT error FROM import_queue WHERE username = 'ruchan'`).error, 'не для узбекского рынка');
  assert.equal(ch('fwdsource').is_uz, 1, 'узбекский язык распознан');

  // Частный канал: профиль по ссылке-приглашению, без постов
  const tg = require(R + 'telegram');
  const invite = tg.parseInvite('https://t.me/joinchat/PrivAteHash12345');
  assert.equal(invite, 'https://t.me/+PrivAteHash12345');
  const { lastInsertRowid: pid } = db.run(`INSERT INTO channels (username, title, status, is_private, invite_link) VALUES ('private_test', '?', 'approved', 1, ?)`, invite);
  const ps = await syncChannel(db.get('SELECT * FROM channels WHERE id = ?', pid));
  assert.ok(ps.ok);
  const priv = db.get('SELECT * FROM channels WHERE id = ?', pid);
  console.log('private:', priv.title, priv.subscribers, priv.type, priv.is_uz);
  assert.equal(priv.subscribers, 3210);
  assert.equal(priv.type, 'channel');
  assert.equal(priv.is_uz, 1);
  assert.equal(db.get('SELECT COUNT(*) n FROM posts WHERE channel_id = ?', pid).n, 0);

  // Скачок подписчиков: история 20 дней с ростом +50/день, затем +30 000 за сутки и отток
  db.run('DELETE FROM stats WHERE channel_id = ?', good.id);
  let subs = 90000;
  for (let d = 20; d >= 0; d--) {
    if (d === 5) subs += 30000; else if (d < 5) subs -= 3000; else subs += 50;
    db.run(`INSERT INTO stats (channel_id, date, subscribers) VALUES (?, date('now', ?), ?)`, good.id, `-${d} day`, subs);
  }
  db.run('UPDATE channels SET subscribers = ? WHERE id = ?', subs, good.id);
  const r = require(R + 'analysis').analyze(good.id);
  console.log('spike:', r.score, r.reasons.map((x) => x.text));
  assert.ok(r.reasons.some((x) => x.text.startsWith('Резкий прирост')));
  assert.ok(r.reasons.some((x) => x.text.startsWith('После скачка')));

  // Паук: листает историю goodchan и находит канал в старом посте
  const { crawlStep } = require(R + 'crawler');
  while (await crawlStep()) {}
  while (await importer.processOne()) {}
  assert.equal(ch('deepchan')?.status, 'approved', 'паук нашёл канал в старых постах');
  assert.equal(ch('goodchan').crawl_done, 1);
  console.log('crawl:', require(R + 'crawler').crawlStats());

  const s = await syncChannel(ch('fakechan'));
  assert.ok(s.ok);
  console.log('ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
