// server/services/validateOrder.js
//
// Валідація даних форми замовлення. Нічого не пише в БД (її й немає) —
// просто перевіряє й повертає або { valid: true, cleaned }, або
// { valid: false, errors }.

// Латиниця + пробіли/дефіс/апостроф — типово для міжнародної доставки
// (щоб поштові служби могли прочитати ім'я).
const NAME_RE = /^[A-Za-z][A-Za-z\s'-]{1,79}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Телефон з кодом країни: необов'язковий "+", 7-15 цифр (стандарт E.164).
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
const ZIP_RE = /^[A-Za-z0-9][A-Za-z0-9\s-]{1,11}$/;

const FIELD_LIMITS = {
  country: 60,
  city: 60,
  addressLine1: 120,
  addressLine2: 120,
};

function trimOrEmpty(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function validateOrderPayload(body) {
  const errors = {};
  const cleaned = {};

  cleaned.fullName = trimOrEmpty(body.fullName);
  if (!NAME_RE.test(cleaned.fullName)) {
    errors.fullName = "Ім'я має містити лише латинські літери (мінімум 2 символи).";
  }

  cleaned.phone = trimOrEmpty(body.phone).replace(/[\s()-]/g, '');
  if (!PHONE_RE.test(cleaned.phone)) {
    errors.phone = 'Некоректний номер телефону. Вкажіть разом із кодом країни, напр. +995555123456.';
  }

  cleaned.email = trimOrEmpty(body.email).toLowerCase();
  if (!EMAIL_RE.test(cleaned.email)) {
    errors.email = 'Некоректна email-адреса.';
  }

  cleaned.country = trimOrEmpty(body.country);
  if (!cleaned.country || cleaned.country.length > FIELD_LIMITS.country) {
    errors.country = 'Вкажіть країну доставки.';
  }

  cleaned.city = trimOrEmpty(body.city);
  if (!cleaned.city || cleaned.city.length > FIELD_LIMITS.city) {
    errors.city = 'Вкажіть місто доставки.';
  }

  cleaned.zip = trimOrEmpty(body.zip);
  if (!ZIP_RE.test(cleaned.zip)) {
    errors.zip = 'Некоректний поштовий індекс.';
  }

  cleaned.addressLine1 = trimOrEmpty(body.addressLine1);
  if (!cleaned.addressLine1 || cleaned.addressLine1.length > FIELD_LIMITS.addressLine1) {
    errors.addressLine1 = 'Вкажіть адресу (вулиця, будинок, квартира).';
  }

  // Address Line 2 не обов'язкова
  cleaned.addressLine2 = trimOrEmpty(body.addressLine2).slice(0, FIELD_LIMITS.addressLine2);

  cleaned.sessionId = trimOrEmpty(body.sessionId);
  if (!/^[a-f0-9]{24}$/.test(cleaned.sessionId)) {
    errors.sessionId = "Сесія генерації не знайдена — спершу створіть прев'ю картини.";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    cleaned,
  };
}

module.exports = { validateOrderPayload };
