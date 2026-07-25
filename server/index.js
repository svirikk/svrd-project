// server/index.js
require('dotenv').config();

// --- Глобальний запобіжник (друга лінія захисту) ---
// Node.js 18+ за замовчуванням АВАРІЙНО ЗАВЕРШУЄ ВЕСЬ ПРОЦЕС при
// необробленому promise rejection. Це і спричиняло симптом "після
// оформлення замовлення / через якийсь час — Failed to fetch на все":
// один необроблений виняток в async-роуті валив увесь сервер, і Railway
// показував "Failed to fetch" для ЛЮБОГО запиту, поки не перезапустить
// контейнер. Головний фікс — try/catch навколо кожного async-роута
// (див. server/routes/order.js), а це — запобіжник на майбутнє, якщо
// колись хтось (включно зі мною) забуде обгорнути новий роут.
process.on('unhandledRejection', (reason) => {
  console.error('!!! UNHANDLED PROMISE REJECTION (сервер лишається живим, але це треба виправити) !!!');
  console.error(reason);
});

// Справжній uncaughtException (поза Promise-контекстом) — стан процесу
// після цього недостовірний, тож логуємо максимально чітко й свідомо
// завершуємо процес (Railway автоматично перезапустить контейнер) замість
// намагатись "жити далі" в непередбачуваному стані.
process.on('uncaughtException', (err) => {
  console.error('!!! UNCAUGHT EXCEPTION — процес завершується, Railway має перезапустити контейнер !!!');
  console.error(err);
  process.exit(1);
});

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
//
// Обгорнуто в try/catch НАВМИСНО: якщо це впаде (наприклад, Railway Volume
// змонтований з правами, які не дозволяють запис — так уже траплялось і
// валило ввесь сервер ще до старту, тобто ЖОДЕН запит не проходив, навіть
// перше завантаження фото) — тепер у логах буде чітке пояснення, а не
// незрозумілий крах з голим стек-трейсом Node.
try {
  fs.mkdirSync(config.TMP_DIR, { recursive: true });
  fs.mkdirSync(config.ORDERS_DIR, { recursive: true });
} catch (e) {
  console.error('!!! НЕ ВДАЛОСЯ СТВОРИТИ РОБОЧІ ТЕКИ ПРИ СТАРТІ !!!');
  console.error(`Шлях: ${e.path || '(невідомо)'}, код помилки: ${e.code}`);
  if (e.code === 'EACCES') {
    console.error(
      'Схоже на проблему з правами доступу до Railway Volume (якщо він ' +
      'підключений на DATA_DIR) — перевір, що том змонтовано з правами на ' +
      'запис для процесу сервера. Сервер не зможе зберігати замовлення ' +
      'без цього, тому зупиняємось навмисно, а не працюємо в поламаному стані.'
    );
  }
  process.exit(1);
}

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

// Періодичний "пульс" пам'яті раз на 10 хвилин. OOM-крах (вбивство
// контейнера через нестачу пам'яті) сам по собі НІЧОГО не пише в наші
// логи — Railway просто вбиває процес ззовні. Цей пульс лишає слід у
// логах ДО того, як це станеться, щоб заднім числом можна було побачити,
// чи пам'ять поступово зростала перед крахом, чи ні.
setInterval(() => {
  const m = process.memoryUsage();
  console.log(
    `[heartbeat] rss=${(m.rss / 1024 / 1024).toFixed(0)}MB ` +
    `heapUsed=${(m.heapUsed / 1024 / 1024).toFixed(0)}MB ` +
    `heapTotal=${(m.heapTotal / 1024 / 1024).toFixed(0)}MB`
  );
}, 10 * 60 * 1000);
