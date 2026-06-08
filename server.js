require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const { initializeDatabase } = require('./db/database');

const authRoutes  = require('./routes/auth');
const appRoutes   = require('./routes/app');
const adminRoutes = require('./routes/admin');
const { injectNavData }  = require('./middleware/nav');
const { detectPlatform } = require('./middleware/platform');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'powerbi-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Must run before login/nav so the requesting domain is resolved to a
// platform (tenant) before any auth or data-access decisions are made.
app.use(detectPlatform);
app.use(injectNavData);

app.get('/login', (req, res) => res.redirect('/auth/login'));

app.use('/auth',  authRoutes);
app.use('/admin', adminRoutes);
app.use('/',      appRoutes);

app.use((req, res) => {
  const user = req.session?.user || null;
  res.status(404).render('error', { user, message: 'Page not found.', code: 404 });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n  Power BI Web App running at http://localhost:${PORT}`);
      console.log(`  Default login: admin@company.com / admin123\n`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
