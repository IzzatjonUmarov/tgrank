// Полная синхронизация одного канала: профиль, посты, аналитика и поиск новых каналов в постах
const db = require('./db');
const config = require('./config');
const { fetchChannelInfo, fetchInviteInfo, fetchPosts } = require('./telegram');
const { applyInfo } = require('./channels');
const { savePosts, analyze } = require('./analysis');
const { isUzbekMarket, guessLanguage } = require('./classify');

// Профиль канала: публичный — по username, частный — по пригласительной ссылке
function fetchProfile(channel) {
  return channel.is_private ? fetchInviteInfo(channel.invite_link, channel.username) : fetchChannelInfo(channel.username);
}

async function syncChannel(channel) {
  const info = await fetchProfile(channel);
  if (!info) return { ok: false, error: channel.is_private ? 'ссылка-приглашение недействительна' : 'канал не найден в Telegram' };
  applyInfo(channel.id, info);
  // У частных каналов нет веб-просмотра постов — только подписчики
  const page = info.type === 'channel' && !channel.is_private ? await fetchPosts(channel.username).catch(() => null) : null;
  return { ok: true, info, analysis: applyPage(channel, info, page) };
}

// Обработка загруженной страницы постов: посты, автопоиск, регион, язык, анализ
function applyPage(channel, info, page) {
  if (page) {
    savePosts(channel.id, page.posts);
    if (config.discovery) enqueueDiscovered(page.mentions);
  }
  // «Это UZ», отмеченное модератором, не сбрасывается
  db.run('UPDATE channels SET is_uz = CASE WHEN is_uz = 1 THEN 1 ELSE ? END WHERE id = ?', isUzbekMarket(info, page?.text).ok ? 1 : 0, channel.id);
  // Язык каналов из импорта уточняем по текстам постов (у добавленных людьми язык выбрал владелец)
  if (page?.text && !channel.added_by) {
    const lang = languageOfPosts(page.text);
    if (lang) db.run('UPDATE channels SET language = ? WHERE id = ?', lang, channel.id);
  }
  return analyze(channel.id);
}

function languageOfPosts(text) {
  const counts = {};
  for (const chunk of text.split('\n').filter((t) => t.length > 40)) {
    const lang = guessLanguage({ title: '', description: chunk });
    counts[lang] = (counts[lang] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top && top[0] !== 'other' ? top[0] : null;
}

async function syncPosts(channelId, username) {
  const page = await fetchPosts(username).catch(() => null);
  if (!page) return null;
  savePosts(channelId, page.posts);
  if (config.discovery) enqueueDiscovered(page.mentions);
  return page;
}

// Упомянутые и репостнутые каналы попадают в очередь импорта
function enqueueDiscovered(usernames) {
  if (!usernames.length) return;
  const queued = db.get(`SELECT COUNT(*) AS n FROM import_queue WHERE status = 'queued'`).n;
  if (queued >= config.discoveryQueueLimit) return;
  for (const u of usernames.slice(0, 100)) {
    if (db.get('SELECT 1 FROM channels WHERE username = ?', u)) continue;
    // Чем чаще канал упоминают, тем раньше он будет проверен
    db.run(`INSERT INTO import_queue (username, source, approve) VALUES (?, 'discovery', ?)
            ON CONFLICT(username) DO UPDATE SET mentions = mentions + 1 WHERE status = 'queued'`, u, config.autoApproveDiscovered ? 1 : 0);
  }
}

module.exports = { syncChannel, syncPosts, fetchProfile, applyPage, enqueueDiscovered };
