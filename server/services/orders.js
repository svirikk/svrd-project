// server/services/orders.js
//
// Постійне сховище замовлень: data/orders/<код>.json.
// На відміну від tmp/<sessionId>/ (яка чиститься за годинами), ці записи
// живуть тижнями/місяцями — саме звідси застосунок складання бере
// послідовність пінів і зберігає прогрес користувача.
//
// ВАЖЛИВО (див. config.js і README): на Railway цей шлях переживає редеплой
// ТІЛЬКИ якщо підключено Volume саме на DATA_DIR.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// Символи без 0/O та 1/I — щоб код, продиктований по телефону чи
// передрукований з SMS, не плутався між "нуль" і "О", "один" і "І".
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_FORMAT_RE = /^SA-\d{8}-[A-Z0-9]{4}$/;

function randomSuffix(length = 4) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function orderFilePath(code) {
  // Код завжди перевіряється форматом ПЕРЕД тим, як потрапити в шлях файлу —
  // це запобігає path traversal (наприклад код виду "../../etc/passwd").
  return path.join(config.ORDERS_DIR, `${code}.json`);
}

function isValidCodeFormat(code) {
  return typeof code === 'string' && CODE_FORMAT_RE.test(code);
}

/**
 * Генерує унікальний код замовлення формату SA-YYYYMMDD-XXXX, перевіряючи
 * колізії проти вже існуючих файлів у ORDERS_DIR. Довжина суфікса — 4
 * символи з алфавіту без плутаних символів (33^4 ≈ 1.19M комбінацій на
 * день) — з rate-limit на вгадування (див. middleware/rateLimit.js) цього
 * більш ніж достатньо для малого/середнього бізнесу.
 */
function generateOrderCode() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const datePart = `${y}${m}${d}`;

  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = `SA-${datePart}-${randomSuffix(4)}`;
    if (!fs.existsSync(orderFilePath(code))) {
      return code;
    }
  }

  // Практично неможливо (означало б 20 колізій поспіль), але якщо раптом —
  // краще впасти з чіткою помилкою, ніж мовчки видати задвоєний код.
  throw new Error('Не вдалося згенерувати унікальний код замовлення за розумну кількість спроб.');
}

/**
 * Зберігає новий запис замовлення. pins — повна послідовність пінів
 * (з C++ рушія), customer — валідовані дані форми (без sessionId).
 */
function saveOrder(code, { customer, stats, pins }) {
  if (!isValidCodeFormat(code)) {
    throw new Error(`Некоректний формат коду замовлення: ${code}`);
  }
  fs.mkdirSync(config.ORDERS_DIR, { recursive: true });

  const record = {
    code,
    createdAt: new Date().toISOString(),
    customer,
    stats,
    pins,
    progress: {
      currentStep: 0,
      updatedAt: new Date().toISOString(),
      completedAt: null, // проставляється в updateProgress, коли крок доходить до кінця
    },
  };

  fs.writeFileSync(orderFilePath(code), JSON.stringify(record));
  return record;
}

function getOrder(code) {
  if (!isValidCodeFormat(code)) return null;
  const fp = orderFilePath(code);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Оновлює лише прогрес (поточний крок), не займаючи чогось іншого в записі.
 * Повертає оновлений запис, або null якщо замовлення не знайдено чи step
 * виходить за межі довжини послідовності пінів.
 *
 * Проставляє progress.completedAt при досягненні останнього кроку — саме
 * цей момент є відліком для автоматичного видалення запису (див.
 * cleanupCompletedOrders). Якщо людина повернулась назад ПІСЛЯ завершення
 * (наприклад щоб ще раз перевірити середину роботи) — completedAt
 * скидається в null, доки вона знову не дійде до кінця.
 */
function updateProgress(code, step) {
  const order = getOrder(code);
  if (!order) return null;

  const maxStep = order.pins.length - 1;
  if (!Number.isInteger(step) || step < 0 || step > maxStep) {
    return null;
  }

  const wasCompleted = Boolean(order.progress && order.progress.completedAt);
  const isCompletedNow = step === maxStep;

  order.progress = {
    currentStep: step,
    updatedAt: new Date().toISOString(),
    completedAt: isCompletedNow
      ? (wasCompleted ? order.progress.completedAt : new Date().toISOString())
      : null,
  };

  fs.writeFileSync(orderFilePath(code), JSON.stringify(order));
  return order;
}

/**
 * Видаляє записи замовлень, завершені більше ніж maxAgeDays тому.
 * НІКОЛИ не чіпає незавершені замовлення, незалежно від їхнього віку —
 * людина може призупинити складання на будь-який термін.
 * Повертає кількість видалених записів (корисно для логів).
 */
function cleanupCompletedOrders(maxAgeDays) {
  if (!fs.existsSync(config.ORDERS_DIR)) return 0;

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  for (const entry of fs.readdirSync(config.ORDERS_DIR)) {
    if (!entry.endsWith('.json')) continue;
    const fp = path.join(config.ORDERS_DIR, entry);

    let record;
    try {
      record = JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (e) {
      continue; // пошкоджений файл — не чіпаємо, хай залишається для ручного розбору
    }

    const completedAt = record.progress && record.progress.completedAt;
    if (!completedAt) continue; // не завершено — ніколи не видаляємо за віком

    const completedMs = new Date(completedAt).getTime();
    if (!Number.isNaN(completedMs) && completedMs < cutoffMs) {
      fs.unlinkSync(fp);
      deleted++;
    }
  }

  return deleted;
}

module.exports = {
  generateOrderCode,
  saveOrder,
  getOrder,
  updateProgress,
  cleanupCompletedOrders,
  isValidCodeFormat,
};
