function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  res.locals.user = req.session.user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', {
      user: req.session.user,
      message: 'Access denied. Admin privileges required.',
      code: 403
    });
  }
  res.locals.user = req.session.user;
  next();
}

module.exports = { requireAuth, requireAdmin };
