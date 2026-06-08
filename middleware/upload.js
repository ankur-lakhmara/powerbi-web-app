const fs     = require('fs');
const path   = require('path');
const multer = require('multer');

const LOGO_DIR    = path.join(__dirname, '..', 'public', 'uploads', 'platform-logos');
const PUBLIC_PATH = '/uploads/platform-logos';

fs.mkdirSync(LOGO_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGO_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `platform-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif'];

const uploadPlatformLogo = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_TYPES.includes(file.mimetype));
  }
}).single('logo');

// Returns the public URL for an uploaded logo file, or null if none was uploaded.
function logoUrlFor(file) {
  return file ? `${PUBLIC_PATH}/${file.filename}` : null;
}

module.exports = { uploadPlatformLogo, logoUrlFor, LOGO_DIR };
