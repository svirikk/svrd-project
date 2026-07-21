// server/routes/assembly.js
//
// API для застосунку складання (окрема сторінка, буде в наступних частинах):
//   GET  /api/assembly/:code            — отримати послідовність пінів + прогрес
//   POST /api/assembly/:code/progress   — зберегти поточний крок

const express = require('express');
const config = require('../config');
const orders = require('../services/orders');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const lookupLimiter = createRateLimiter({
  windowMs: config.ASSEMBLY_RATE_LIMIT_WINDOW_MS,
  max: config.ASSEMBLY_RATE_LIMIT_MAX,
  message: 'Забагато спроб входу. Спробуйте ще раз за кілька хвилин.',
});

// Окремий, набагато щедріший ліміт для синхронізації прогресу — це фоновий
// трафік від уже відкритої сесії складання (автоплей на 1с/крок може дати
// сотні запитів за годину), а не спроба підбору коду. Захист від підбору
// коду забезпечує lookupLimiter вище на GET-ендпоінті.
const progressLimiter = createRateLimiter({
  windowMs: config.ASSEMBLY_RATE_LIMIT_WINDOW_MS,
  max: config.ASSEMBLY_PROGRESS_RATE_LIMIT_MAX,
  message: 'Забагато оновлень прогресу. Зачекайте трохи.',
});

router.get('/:code', lookupLimiter, (req, res) => {
  const order = orders.getOrder(req.params.code);

  if (!order) {
    // Свідомо однакова відповідь і для невалідного формату, і для коду,
    // якого просто не існує — не варто підказувати "вгадувачу", що саме
    // не так з введеним кодом.
    res.status(404).json({ ok: false, error: 'Код замовлення не знайдено.' });
    return;
  }

  res.json({
    ok: true,
    code: order.code,
    customerFirstName: (order.customer?.fullName || '').split(' ')[0] || null,
    stats: order.stats,
    pins: order.pins,
    progress: order.progress,
  });
});

router.post('/:code/progress', progressLimiter, express.json(), (req, res) => {
  const step = req.body ? req.body.step : undefined;
  const updated = orders.updateProgress(req.params.code, step);

  if (!updated) {
    res.status(404).json({ ok: false, error: 'Код замовлення не знайдено, або крок некоректний.' });
    return;
  }

  res.json({ ok: true, progress: updated.progress });
});

module.exports = router;
