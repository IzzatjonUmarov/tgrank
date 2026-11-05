// Публичный JSON API (бесплатно, без ключа на этапе 1)
const express = require('express');
const db = require('../db');
const ch = require('../channels');
const { rateLimit } = require('../security');
const { tgLink } = require('../helpers');
const { cpm } = require('../ads');

const router = express.Router();
router.use(rateLimit('api', { max: 120, windowMs: 60_000 }));
router.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); });

const pub = (c) => ({
  username: c.is_private ? null : c.username, id: c.username, private: !!c.is_private, link: tgLink(c), type: c.type, title: c.title, description: c.description,
  avatar: c.avatar_url, category: c.category_slug, language: c.language, subscribers: c.subscribers,
  growth: { day: c.growth_day, week: c.growth_week, month: c.growth_month },
  votes: c.votes, rating: Number(c.rating_avg.toFixed(2)), reviews: c.rating_count,
  avg_reach: c.avg_reach, err: c.err, posts_per_day: c.posts_per_day, engagement: c.engagement,
  ads: c.ads_enabled && c.owner_id ? { currency: c.ad_currency, prices: JSON.parse(c.ad_prices || '[]'), contact: c.ad_contact, note: c.ad_note || null, cpm_uzs: cpm(c) } : null,
  fraud: { score: c.fraud_score, reasons: JSON.parse(c.fraud_reasons || '[]').map((r) => r.text) },
  owner_verified: !!c.owner_id, boosted: !!c.boosted,
});

router.get('/channels', (req, res) => {
  const perPage = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const r = ch.list({ q: req.query.q, type: req.query.type, category: req.query.category, language: req.query.language,
    sort: req.query.sort, page: parseInt(req.query.page, 10) || 1, perPage });
  res.json({ total: r.total, page: r.page, pages: r.pages, items: r.items.map(pub) });
});

router.get('/channels/:username', (req, res) => {
  const c = ch.byUsername(req.params.username);
  if (!c || c.status !== 'approved') return res.status(404).json({ error: 'not_found' });
  res.json({ ...pub(c), position: ch.rankPosition(c) });
});

router.get('/channels/:username/stats', (req, res) => {
  const c = ch.byUsername(req.params.username);
  if (!c || c.status !== 'approved') return res.status(404).json({ error: 'not_found' });
  res.json(ch.history(c.id, Math.min(365, parseInt(req.query.days, 10) || 90)));
});

router.get('/categories', (req, res) => {
  res.json(db.all(`SELECT cat.slug, cat.name, cat.icon, COUNT(c.id) AS count FROM categories cat
    LEFT JOIN channels c ON c.category_id = cat.id AND c.status = 'approved' GROUP BY cat.id ORDER BY cat.sort, cat.name`));
});

module.exports = router;
