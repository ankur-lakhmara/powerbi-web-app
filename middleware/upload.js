const fs     = require('fs');
const path   = require('path');
const multer = require('multer');

const LOGO_DIR       = path.join(__dirname, '..', 'public', 'uploads', 'platform-logos');
const BACKGROUND_DIR = path.join(__dirname, '..', 'public', 'uploads', 'platform-backgrounds');
const PUBLIC_LOGO_PATH       = '/uploads/platform-logos';
const PUBLIC_BACKGROUND_PATH = '/uploads/platform-backgrounds';

fs.mkdirSync(LOGO_DIR, { recursive: true });
fs.mkdirSync(BACKGROUND_DIR, { recursive: true });

const DEST_BY_FIELD = {
  logo:             LOGO_DIR,
  login_background: BACKGROUND_DIR,
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DEST_BY_FIELD[file.fieldname] || LOGO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `platform-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif'];

const uploadPlatformAssets = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_TYPES.includes(file.mimetype));
  }
}).fields([
  { name: 'logo', maxCount: 1 },
  { name: 'login_background', maxCount: 1 },
]);

// Returns the public URL for an uploaded logo file, or null if none was uploaded.
function logoUrlFor(files) {
  const file = files?.logo?.[0];
  return file ? `${PUBLIC_LOGO_PATH}/${file.filename}` : null;
}

// Returns the public URL for an uploaded login background image, or null if none was uploaded.
function backgroundUrlFor(files) {
  const file = files?.login_background?.[0];
  return file ? `${PUBLIC_BACKGROUND_PATH}/${file.filename}` : null;
}

module.exports = { uploadPlatformAssets, logoUrlFor, backgroundUrlFor, LOGO_DIR, BACKGROUND_DIR };
