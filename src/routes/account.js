const express = require('express');
const db = require('../db');
const ch = require('../channels');
const { requireUser } = require('./guards');
const { LANGUAGES } = require('../helpers');
const { parseInvite } = require('../telegram');
const ads = require('../ads');

const router = express.Router();
router.use(requireUser);

router.get('/', (req, res) => {
  const uid = req.user.id;
  const mine = db.all(`SELECT c.*, cat.name AS category_name, (c.boost_until > datetime('now')) AS boosted
    FROM channels c LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE c.added_by = ? OR c.owner_id = ? ORDER BY c.created_at DESC`, uid, uid);
  const favorites = db.all(`SELECT c.*, cat.name AS category_name FROM favorites f
    JOIN channels c ON c.id = f.channel_id LEFT JOIN categories cat ON cat.id = c.category_id
    WHERE f.user_id = ? AND c.status = 'approved' ORDER BY f.created_at DESC`, uid);
  res.render('account/index', { title: 'Личный кабинет', mine, favorites });
});

function ownChannel(req, res) {
  const c = ch.byId(Number(req.params.id));
  if (!c || (c.owner_id !== req.user.id && req.user.role !== 'admin')) {
    res.status(403).render('error', { title: 'Нет доступа', message: 'Редактировать канал может только подтверждённый владелец.' });
    return null;
  }
  return c;
}

router.get('/channel/:id/edit', (req, res) => {
  const c = ownChannel(req, res); if (!c) return;
  res.render('account/edit', { title: 'Настройки канала', channel: c, adPrices: JSON.parse(c.ad_prices || '[]'), FORMATS: ads.FORMATS, CURRENCIES: ads.CURRENCIES });
});

router.post('/channel/:id/edit', (req, res) => {
  const c = ownChannel(req, res); if (!c) return;
  const categoryId = parseInt(req.body.category_id, 10);
  const language = LANGUAGES[req.body.language] ? req.body.language : c.language;
  const tags = String(req.body.tags || '').slice(0, 200);
  db.run('UPDATE channels SET category_id = COALESCE(?, category_id), language = ?, tags = ? WHERE id = ?',
    db.get('SELECT id FROM categories WHERE id = ?', categoryId)?.id ?? null, language, tags, c.id);
  if (c.is_private && req.body.invite_link) {
    const invite = parseInvite(req.body.invite_link);
    if (!invite) { req.flash('error', 'Ссылка-приглашение должна быть вида https://t.me/+…'); return res.redirect(`/account/channel/${c.id}/edit`); }
    if (invite !== c.invite_link) {
      if (db.get('SELECT 1 FROM channels WHERE invite_link = ? AND id != ?', invite, c.id)) { req.flash('error', 'Эта ссылка уже используется другим каналом.'); return res.redirect(`/account/channel/${c.id}/edit`); }
      // Новая ссылка может вести на другой канал — владение нужно подтвердить заново
      db.run(`UPDATE channels SET invite_link = ?, owner_id = NULL, status = 'draft' WHERE id = ?`, invite, c.id);
      req.flash('info', 'Ссылка обновлена. Подтвердите владение заново — после этого канал вернётся в каталог.');
      return res.redirect(`/c/${c.username}/claim`);
    }
  }
  // Реклама: включить может только подтверждённый владелец
  // Админ может только выключить рекламу чужого канала, но не задать цены
  if (req.body.ads_section === '1' && c.owner_id !== req.user.id && req.body.ads_enabled !== '1') {
    db.run('UPDATE channels SET ads_enabled = 0 WHERE id = ?', c.id);
  } else if (req.body.ads_section === '1' && c.owner_id !== req.user.id) {
    req.flash('error', 'Цены на рекламу может указывать только подтверждённый владелец канала.');
    return res.redirect(`/account/channel/${c.id}/edit`);
  } else if (req.body.ads_section === '1') {
    const enabled = req.body.ads_enabled === '1';
    const currency = ads.CURRENCIES[req.body.ad_currency] ? req.body.ad_currency : 'UZS';
    const prices = ads.parsePrices(req.body);
    const contact = ads.parseContact(req.body.ad_contact);
    const note = String(req.body.ad_note || '').trim().slice(0, 1000);
    const back = () => res.redirect(`/account/channel/${c.id}/edit`);
    if (enabled && !c.owner_id) { req.flash('error', 'Принимать рекламу может только канал с подтверждённым владельцем.'); return back(); }
    if (enabled && !contact) { req.flash('error', 'Укажите контакт для связи по рекламе: @username или ссылку t.me.'); return back(); }
    if (enabled && !prices.length && !note) { req.flash('error', 'Укажите хотя бы одну цену или условия, например «цена договорная».'); return back(); }
    db.run(`UPDATE channels SET ads_enabled = ?, ad_currency = ?, ad_prices = ?, ad_min_price_uzs = ?, ad_contact = ?, ad_note = ?, ad_updated_at = datetime('now') WHERE id = ?`,
      enabled ? 1 : 0, currency, JSON.stringify(prices), ads.minPriceUzs(prices, currency), contact, note, c.id);
  }
  req.flash('success', 'Изменения сохранены.');
  res.redirect(`/c/${c.username}`);
});

router.post('/channel/:id/delete', (req, res) => {
  const c = ownChannel(req, res); if (!c) return;
  db.run('DELETE FROM channels WHERE id = ?', c.id);
  req.flash('success', `@${c.username} удалён из каталога.`);
  res.redirect('/account');
});

module.exports = router;
