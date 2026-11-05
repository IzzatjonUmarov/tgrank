function requireUser(req, res, next) {
  if (req.user) return next();
  req.flash('info', 'Войдите, чтобы продолжить.');
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'Доступ запрещён', message: 'Раздел только для администраторов.' });
}
const { safeNext } = require('../security');

module.exports = { requireUser, requireAdmin, safeNext };
