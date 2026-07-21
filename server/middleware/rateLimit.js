// server/middleware/rateLimit.js
//
// Простий in-memory rate limiter (без Redis — достатньо для одного
// інстансу на Railway). Обмежує кількість спроб з однієї IP-адреси за
// вікно часу — головний захист від підбору коду замовлення (сам код
// достатньо довгий, але без обмеження спроб довжина коду мало важить).

function createRateLimiter({ windowMs, max, message }) {
  // IP -> [timestamps]
  const hits = new Map();

  // Періодично прибираємо застарілі записи, щоб Map не росла вічно.
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits.entries()) {
      const fresh = timestamps.filter((t) => t > cutoff);
      if (fresh.length === 0) {
        hits.delete(ip);
      } else {
        hits.set(ip, fresh);
      }
    }
  }, Math.min(windowMs, 60_000)).unref();

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;

    const timestamps = (hits.get(ip) || []).filter((t) => t > cutoff);
    timestamps.push(now);
    hits.set(ip, timestamps);

    if (timestamps.length > max) {
      res.status(429).json({
        ok: false,
        error: message || 'Забагато спроб. Спробуйте ще раз пізніше.',
      });
      return;
    }

    next();
  };
}

module.exports = { createRateLimiter };
