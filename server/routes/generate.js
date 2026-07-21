// server/routes/generate.js
//
// POST /api/generate         — приймає фото, запускає повний пайплайн,
//                               повертає sessionId + посилання на прев'ю.
// GET  /api/generate/preview/:sessionId — віддає згенеровану картинку.

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');
const pipeline = require('../services/pipeline');

const router = express.Router();

const uploadsDir = path.join(config.TMP_DIR, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // Ім'я файлу генеруємо самі — ніколи не довіряємо оригінальному імені
    // від клієнта (шлях/спецсимволи тощо).
    const ext = EXT_BY_MIME[file.mimetype] || '.jpg';
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!config.ALLOWED_MIME.includes(file.mimetype)) {
      cb(new Error('UNSUPPORTED_TYPE'));
      return;
    }
    cb(null, true);
  },
});

router.post('/', (req, res, next) => {
  upload.single('photo')(req, res, async (err) => {
    if (err) {
      let message = 'Не вдалося завантажити файл.';
      if (err.message === 'UNSUPPORTED_TYPE') {
        message = 'Непідтримуваний формат файлу. Завантажте JPG, PNG або WEBP.';
      } else if (err.code === 'LIMIT_FILE_SIZE') {
        message = `Файл завеликий. Максимум ${config.MAX_UPLOAD_MB} МБ.`;
      }
      res.status(400).json({ ok: false, error: message });
      return;
    }

    if (!req.file) {
      res.status(400).json({ ok: false, error: 'Фото не знайдено в запиті (поле "photo").' });
      return;
    }

    const uploadedPath = req.file.path;
    const ext = EXT_BY_MIME[req.file.mimetype] || '.jpg';

    try {
      const result = await pipeline.runGeneration(uploadedPath, ext);

      res.json({
        ok: true,
        sessionId: result.sessionId,
        previewUrl: `/api/generate/preview/${result.sessionId}`,
        stats: result.stats,
        background: result.background,
      });
    } catch (e) {
      next(e);
    } finally {
      // Сирий завантажений файл більше не потрібен — сесія вже має свою копію.
      fs.unlink(uploadedPath, () => {});
    }
  });
});

router.get('/preview/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!/^[a-f0-9]{24}$/.test(sessionId)) {
    res.status(400).json({ ok: false, error: 'Невалідний ідентифікатор сесії.' });
    return;
  }

  const previewPath = path.join(pipeline.sessionDir(sessionId), 'preview_web.jpg');
  if (!fs.existsSync(previewPath)) {
    res.status(404).json({ ok: false, error: "Прев'ю не знайдено (можливо, сесія застаріла)." });
    return;
  }

  res.sendFile(previewPath);
});

module.exports = router;
