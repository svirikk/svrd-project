// server/index.js
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const config = require('./config');
const { cleanupStaleSessions } = require('./services/pipeline');

const generateRouter = require('./routes/generate');
const orderRouter = require('./routes/order');
const assemblyRouter = require('./routes/assembly');
const orders = require('./services/orders');

// Переконуємось, що робочі папки існують — важливо для "чистого" Docker-образу,
// де tmp/ під час білду ще не створена.
fs.mkdirSync(config.TMP_DIR, { recursive: true });
fs.mkdirSync(config.ORDERS_DIR, { recursive: true });

// Прибираємо "осиротілі" сесії (людина згенерувала прев'ю, але не оформила
// замовлення) — раз на годину, і одразу при старті сервера.
cleanupStaleSessions();
setInterval(cleanupStaleSessions, 60 * 60 * 1000);

// Прибираємо ЗАВЕРШЕНІ замовлення старші за грейс-період (див. config.js) —
// раз на добу. Незавершені замовлення це НІКОЛИ не чіпає, незалежно від віку.
function runOrderCleanup() {
  const deleted = orders.cleanupCompletedOrders(config.ORDER_RETENTION_DAYS_AFTER_COMPLETION);
  if (deleted > 0) {
    console.log(`Очищення: видалено ${deleted} завершених замовлень старших за ${config.ORDER_RETENTION_DAYS_AFTER_COMPLETION} днів.`);
  }
}
runOrderCleanup();
setInterval(runOrderCleanup, 24 * 60 * 60 * 1000);

const app = express();

// Railway (і більшість PaaS) ставить реверс-проксі перед застосунком. Без
// цього req.ip завжди повертав би IP проксі, а не реального клієнта — і
// rate-limiter (server/middleware/rateLimit.js) обмежував би всіх
// користувачів разом як єдину "IP-адресу", замість кожного окремо.
app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(config.PUBLIC_DIR));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'string-art-backend' });
});

// Публічна (не секретна) частина конфігу — щоб фронтенд не дублював вручну
// значення на кшталt "макс. розмір файлу" чи "кількість пінів" і вони не
// розходилися з реальним бекендом.
app.get('/api/config', (req, res) => {
  res.json({
    numPins: config.NUM_PINS,
    minSteps: config.MIN_STEPS,
    maxSteps: config.MAX_STEPS,
    maxUploadMb: config.MAX_UPLOAD_MB,
    allowedMime: config.ALLOWED_MIME,
    pinCircleDiameterCm: config.PIN_CIRCLE_DIAMETER_CM,
  });
});

app.use('/api/generate', generateRouter);
app.use('/api/order', orderRouter);
app.use('/api/assembly', assemblyRouter);

// 404 для невідомих /api/* маршрутів (щоб не віддавати HTML-сторінку фронтенду)
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Маршрут не знайдено.' });
});

// Централізоване опрацювання помилок — фронтенд завжди отримує зрозумілий
// JSON, а не сирий HTML зі стек-трейсом.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    ok: false,
    error: err.publicMessage || 'Внутрішня помилка сервера. Спробуйте ще раз.',
  });
});

app.listen(config.PORT, () => {
  console.log(`String Art backend запущено на порту ${config.PORT}`);
});
