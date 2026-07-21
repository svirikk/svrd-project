// server/services/pipeline.js
//
// Оркестрація повного циклу генерації: збережене фото -> convert.py
// (адаптивна предобробка) -> C++ рушій (плетіння ниток) -> JPG для сайту.
//
// Кожен запит отримує свою ізольовану папку tmp/<sessionId>/, щоб паралельні
// запити не тупцювали по одних і тих самих файлах.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

function newSessionId() {
  return crypto.randomBytes(12).toString('hex');
}

function sessionDir(sessionId) {
  return path.join(config.TMP_DIR, sessionId);
}

/**
 * Запускає дочірній процес і збирає stdout/stderr. Не кидає виняток на
 * ненульовий код виходу — повертає його, щоб виклик міг вирішити сам,
 * як реагувати (у нас же скрипти самі пишуть ##RESULT##/##CONVERT_RESULT##
 * навіть у випадку помилки).
 */
function runProcess(command, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Процес "${command}" перевищив ліміт часу (${timeoutMs}мс) і був примусово зупинений.`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Витягує рядок ##PREFIX##{...json...} з виводу процесу й парсить його.
 * Повертає null, якщо такого рядка немає (і тоді викликач сам вирішує, чи
 * це фатально).
 */
function extractTaggedJson(output, prefix) {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith(prefix)) {
      try {
        return JSON.parse(line.slice(prefix.length));
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

class PipelineError extends Error {
  constructor(message, publicMessage, status = 500) {
    super(message);
    this.publicMessage = publicMessage || message;
    this.status = status;
  }
}

/**
 * Повний цикл: uploadedFilePath (вже на диску, наприклад з multer) ->
 * { sessionId, previewWebPath, previewFullPath, originalPath, stats, backgroundWarning }
 */
async function runGeneration(uploadedFilePath, originalExt) {
  const sessionId = newSessionId();
  const dir = sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const originalPath = path.join(dir, `original${originalExt}`);
  const inputPgm = path.join(dir, 'input.pgm');
  const outputPgm = path.join(dir, 'output.pgm');
  const previewFull = path.join(dir, 'preview_full.jpg');
  const previewWeb = path.join(dir, 'preview_web.jpg');

  fs.copyFileSync(uploadedFilePath, originalPath);

  // --- Крок 1: адаптивна предобробка фото ---
  const convertResult = await runProcess(
    config.PYTHON_BIN,
    [config.CONVERT_SCRIPT, originalPath, inputPgm, String(config.IMAGE_SIZE)],
    { timeoutMs: 20_000 }
  );
  const convertJson = extractTaggedJson(convertResult.stdout, '##CONVERT_RESULT##');

  if (convertResult.code !== 0 || !convertJson || !convertJson.ok) {
    throw new PipelineError(
      `convert.py впав (code=${convertResult.code}): ${convertResult.stderr}`,
      'Не вдалося обробити фото. Спробуйте інше зображення (чіткіше, більшого розміру).',
      422
    );
  }

  // --- Крок 2: C++ рушій плетіння ниток ---
  const engineResult = await runProcess(
    config.STRING_ART_BIN,
    [
      inputPgm,
      String(config.NUM_PINS),
      String(config.DRAFT_OPACITY_CLI_ARG),
      String(config.THRESHOLD),
      String(config.SKIPPED_NEIGHBORS),
      String(config.SCALE_FACTOR),
      String(config.MIN_STEPS),
      String(config.MAX_STEPS),
      outputPgm,
    ],
    { timeoutMs: config.GENERATION_TIMEOUT_MS }
  );
  const engineJson = extractTaggedJson(engineResult.stdout, '##RESULT##');

  if (engineResult.code !== 0 || !engineJson || !fs.existsSync(outputPgm)) {
    throw new PipelineError(
      `C++ рушій впав (code=${engineResult.code}): ${engineResult.stderr}`,
      'Не вдалося згенерувати картину. Спробуйте ще раз трохи пізніше.',
      500
    );
  }

  // --- Крок 3: PGM -> JPG (повна версія + версія для сайту) ---
  const jpgResult = await runProcess(
    config.PYTHON_BIN,
    [path.join(__dirname, '..', '..', 'pgm_to_image.py'), outputPgm, previewFull, previewWeb, '1400'],
    { timeoutMs: 20_000 }
  );
  const jpgJson = extractTaggedJson(jpgResult.stdout, '##PGM_RESULT##');

  if (jpgResult.code !== 0 || !jpgJson || !jpgJson.ok) {
    throw new PipelineError(
      `pgm_to_image.py впав (code=${jpgResult.code}): ${jpgResult.stderr}`,
      'Картину згенеровано, але не вдалося підготувати прев\'ю. Спробуйте ще раз.',
      500
    );
  }

  const stats = {
    lines: engineJson.lines,
    meters: Math.round(engineJson.meters * 10) / 10,
    metersWithMargin: Math.round(engineJson.metersWithMargin * 10) / 10,
  };

  if (!Array.isArray(engineJson.pins) || engineJson.pins.length === 0) {
    throw new PipelineError(
      'C++ рушій не повернув послідовність пінів (поле "pins" відсутнє у ##RESULT##).',
      'Не вдалося підготувати інструкцію складання. Спробуйте ще раз.',
      500
    );
  }

  // Зберігаємо статистику ПОРУЧ ОКРЕМО від послідовності пінів:
  //  - stats.json  читає /api/order одразу після оформлення (метраж/кількість ліній)
  //  - pins.json   читає той самий /api/order, щоб покласти піни в постійний
  //                запис замовлення (data/orders/<код>.json) — саме він потім
  //                живить застосунок складання, а не тимчасова сесія tmp/.
  fs.writeFileSync(path.join(dir, 'stats.json'), JSON.stringify(stats));
  fs.writeFileSync(path.join(dir, 'pins.json'), JSON.stringify(engineJson.pins));

  return {
    sessionId,
    files: { originalPath, previewFull, previewWeb },
    stats,
    background: {
      faceDetected: convertJson.faceDetected,
      complexity: convertJson.backgroundComplexity,
      warningLevel: convertJson.warningLevel,   // "none" | "medium" | "high"
      warningMessage: convertJson.warningMessage,
    },
  };
}

/** Видаляє папку сесії (викликається після успішного замовлення, і в
 *  фоновому прибиранні застарілих сесій). */
function cleanupSession(sessionId) {
  const dir = sessionDir(sessionId);
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

/** Прибирає сесії, старіші за maxAgeMs (щоб не роздувати диск сирітськими
 *  файлами від людей, які згенерували прев'ю, але не оформили замовлення). */
function cleanupStaleSessions(maxAgeMs = 2 * 60 * 60 * 1000) {
  fs.readdir(config.TMP_DIR, (err, entries) => {
    if (err) return;
    const now = Date.now();
    for (const entry of entries) {
      if (entry === '.gitkeep') continue;
      const dir = path.join(config.TMP_DIR, entry);
      fs.stat(dir, (statErr, st) => {
        if (statErr || !st.isDirectory()) return;
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rm(dir, { recursive: true, force: true }, () => {});
        }
      });
    }
  });
}

module.exports = {
  runGeneration,
  cleanupSession,
  cleanupStaleSessions,
  sessionDir,
  PipelineError,
};
