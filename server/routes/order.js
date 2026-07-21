// server/routes/order.js
//
// POST /api/order — приймає дані форми (JSON), перевіряє їх, знаходить
// файли попередньо згенерованої сесії (sessionId з /api/generate),
// генерує унікальний код замовлення, ЗБЕРІГАЄ ПОСТІЙНИЙ ЗАПИС (піни для
// застосунку складання) — це джерело правди для замовлення — і вже потім,
// best-effort, шле сповіщення в Telegram і прибирає тимчасові файли сесії.

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const pipeline = require('../services/pipeline');
const telegram = require('../services/telegram');
const orders = require('../services/orders');
const { buildPinoutText } = require('../services/pinout');
const { validateOrderPayload } = require('../services/validateOrder');

const router = express.Router();

router.post('/', async (req, res, next) => {
  const { valid, errors, cleaned } = validateOrderPayload(req.body || {});

  if (!valid) {
    res.status(400).json({ ok: false, error: 'Форма заповнена некоректно.', fieldErrors: errors });
    return;
  }

  const dir = pipeline.sessionDir(cleaned.sessionId);
  const originalCandidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('original.')) : [];
  const previewFull = path.join(dir, 'preview_full.jpg');
  const statsPath = path.join(dir, 'stats.json');
  const pinsPath = path.join(dir, 'pins.json');

  if (originalCandidates.length === 0 || !fs.existsSync(previewFull) || !fs.existsSync(pinsPath)) {
    res.status(410).json({
      ok: false,
      error: "Сесія генерації застаріла або не знайдена. Будь ласка, згенеруйте прев'ю ще раз перед замовленням.",
    });
    return;
  }

  const originalPath = path.join(dir, originalCandidates[0]);

  let stats = { lines: config.MIN_STEPS, meters: null, metersWithMargin: null };
  let pins = null;
  try {
    stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "Дані генерації пошкоджені. Будь ласка, згенеруйте прев'ю ще раз.",
    });
    return;
  }

  if (!Array.isArray(pins) || pins.length === 0) {
    res.status(500).json({ ok: false, error: "Послідовність пінів відсутня. Згенеруйте прев'ю ще раз." });
    return;
  }

  // --- Джерело правди: постійний запис замовлення (переживає чистку tmp/) ---
  let orderNumber;
  try {
    orderNumber = orders.generateOrderCode();
    orders.saveOrder(orderNumber, {
      customer: {
        fullName: cleaned.fullName,
        phone: cleaned.phone,
        email: cleaned.email,
        country: cleaned.country,
        city: cleaned.city,
        zip: cleaned.zip,
        addressLine1: cleaned.addressLine1,
        addressLine2: cleaned.addressLine2,
      },
      stats,
      pins,
    });
  } catch (e) {
    next(e);
    return;
  }

  // Клієнт отримує код одразу — замовлення вже гарантовано збережено,
  // незалежно від того, чи вдасться сповіщення в Telegram нижче.
  res.json({ ok: true, orderNumber });

  // --- Best-effort сповіщення в Telegram (не блокує відповідь клієнту) ---
  try {
    const pinoutText = buildPinoutText({ code: orderNumber, customer: cleaned, stats, pins });
    await telegram.sendOrderNotification(orderNumber, cleaned, stats, { originalPath, previewFull }, pinoutText);
  } catch (e) {
    console.error(`[order ${orderNumber}] Telegram-сповіщення не вдалося:`, e.message);
    console.error(`[order ${orderNumber}] Замовлення все одно збережено в data/orders/${orderNumber}.json — перевірте вручну.`);
  }

  // Тимчасові файли сесії (фото/картинки) більше не потрібні — все необхідне
  // (піни + статистика) вже перенесено в постійний запис замовлення.
  pipeline.cleanupSession(cleaned.sessionId);
});

module.exports = router;
