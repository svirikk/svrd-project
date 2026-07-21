// server/services/telegram.js
//
// Відправка замовлення в Telegram — і як структуроване текстове повідомлення
// (щоб було зручно читати), і як медіа-група з двома фото (оригінал +
// прев'ю). Ніякої БД — Telegram-чат і є "базою даних" замовлень.

const fs = require('fs/promises');
const path = require('path');
const config = require('../config');

function apiUrl(method) {
  return `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

class TelegramError extends Error {}

function buildOrderText(orderNumber, order, stats) {
  const lines = [
    `🆕 <b>Нове замовлення ${escapeHtml(orderNumber)}</b>`,
    `📅 ${escapeHtml(new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }))}`,
    '',
    `👤 <b>Клієнт:</b> ${escapeHtml(order.fullName)}`,
    `📞 <b>Телефон:</b> ${escapeHtml(order.phone)}`,
    `✉️ <b>Email:</b> ${escapeHtml(order.email)}`,
    '',
    '📦 <b>Доставка:</b>',
    `${escapeHtml(order.country)}, ${escapeHtml(order.city)}, ${escapeHtml(order.zip)}`,
    escapeHtml(order.addressLine1),
  ];
  if (order.addressLine2) {
    lines.push(escapeHtml(order.addressLine2));
  }
  lines.push('');
  lines.push('🧵 <b>Картина:</b>');
  lines.push(`Ліній: ${stats.lines}`);
  lines.push(`Метраж нитки: ~${stats.metersWithMargin} м (із запасом)`);
  lines.push('');
  lines.push(`🧩 <b>Код для застосунку складання:</b> ${escapeHtml(orderNumber)}`);
  lines.push('Цей самий код — надішліть клієнту SMS/поштою для входу в застосунок складання.');

  return lines.join('\n');
}

async function telegramFetch(method, body) {
  const res = await fetch(apiUrl(method), {
    method: 'POST',
    ...body,
  });

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new TelegramError(`Telegram API повернув не-JSON відповідь (HTTP ${res.status})`);
  }

  if (!res.ok || !json.ok) {
    throw new TelegramError(`Telegram API error: ${json.description || res.statusText}`);
  }

  return json;
}

async function sendMessage(text) {
  return telegramFetch('sendMessage', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });
}

/**
 * Надсилає до 10 фото однією медіа-групою (альбомом). files:
 * [{ path, filename, caption? }]
 */
async function sendPhotoGroup(files) {
  const form = new FormData();
  form.append('chat_id', config.TELEGRAM_CHAT_ID);

  const media = [];
  for (let i = 0; i < files.length; i++) {
    const { path: filePath, filename, caption } = files[i];
    const buffer = await fs.readFile(filePath);
    const fieldName = `file${i}`;
    form.append(fieldName, new Blob([buffer], { type: 'image/jpeg' }), filename);
    media.push({
      type: 'photo',
      media: `attach://${fieldName}`,
      ...(caption ? { caption } : {}),
    });
  }
  form.append('media', JSON.stringify(media));

  return telegramFetch('sendMediaGroup', { body: form });
}

/**
 * Надсилає текстовий документ (наприклад, файл розпіновки). content —
 * рядок, генерується в пам'яті, без проміжного файлу на диску — Telegram
 * media groups не змішують фото з документами в одному альбомі, тому це
 * ОКРЕМИЙ виклик sendDocument, а не частина sendPhotoGroup.
 */
async function sendDocument({ content, filename, caption }) {
  const form = new FormData();
  form.append('chat_id', config.TELEGRAM_CHAT_ID);
  form.append('document', new Blob([content], { type: 'text/plain; charset=utf-8' }), filename);
  if (caption) form.append('caption', caption);
  return telegramFetch('sendDocument', { body: form });
}

/**
 * Головна функція: відправляє повне замовлення в Telegram — текст +
 * альбом із двома фото (оригінал клієнта та згенероване прев'ю) + окремим
 * повідомленням текстовий файл розпіновки (підстраховка на випадок збою
 * сайту — власник бізнесу зможе вручну переслати його клієнту).
 * orderNumber генерується й перевіряється на унікальність окремо, в
 * server/services/orders.js (тут це вже готовий, унікальний код).
 */
async function sendOrderNotification(orderNumber, order, stats, files, pinoutText) {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
    throw new TelegramError(
      'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не налаштовані в .env — нема куди відправляти замовлення.'
    );
  }

  const text = buildOrderText(orderNumber, order, stats);

  await sendMessage(text);

  await sendPhotoGroup([
    { path: files.originalPath, filename: `original-${orderNumber}${path.extname(files.originalPath)}`, caption: 'Оригінальне фото клієнта' },
    { path: files.previewFull, filename: `preview-${orderNumber}.jpg`, caption: 'Згенероване прев\'ю картини' },
  ]);

  if (pinoutText) {
    await sendDocument({
      content: pinoutText,
      filename: `pinout-${orderNumber}.txt`,
      caption: `🧵 Розпіновка ${orderNumber} — текстовий бекап на випадок збою сайту.`,
    });
  }

  return orderNumber;
}

module.exports = {
  sendOrderNotification,
  buildOrderText,
  escapeHtml,
  TelegramError,
};
