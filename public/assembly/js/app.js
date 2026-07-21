// public/assembly/js/app.js
//
// Застосунок складання: вхід за кодом (Частина 2), головний екран з колесом
// (Частина 3), і тепер (Частина 4) — контролі Next/Previous/Play-Pause,
// швидкість автоплею, перехід на довільний крок, і найголовніше —
// збереження прогресу так, щоб воно НЕ злітало навіть якщо людина закриє
// вкладку/очистить браузер/продовжить з іншого телефону.
//
// Стратегія збереження прогресу (детально обговорено з клієнтом):
//   - localStorage — швидкий локальний кеш, пишеться при КОЖНІЙ зміні кроку.
//     Це основне джерело при поверненні на той самий пристрій/браузер.
//   - Сервер — підстраховка на випадок втрати localStorage (очищення
//     браузера, iOS Safari ITP, інший пристрій/браузер). Синхронізується не
//     на кожен крок (це були б тисячі запитів), а раз на кілька кроків +
//     примусово при паузі, переході на довільний крок, і при закритті/
//     згортанні вкладки (через sendBeacon — найнадійніший спосіб встигнути
//     відправити запит, поки сторінка ще жива).
//   - При вході: якщо localStorage для ЦЬОГО коду є — довіряємо йому
//     (найсвіжіше). Якщо нема (інший пристрій чи очищено) — беремо крок із
//     сервера.

(function () {
  'use strict';

  const LAST_CODE_KEY = 'sa_last_order_code';
  const CODE_RE = /^SA-\d{8}-[A-Z0-9]{4}$/;
  const SYNC_EVERY_N_STEPS = 15;

  const viewLogin = document.getElementById('view-login');
  const viewMain = document.getElementById('view-main');
  const form = document.getElementById('login-form');
  const codeInput = document.getElementById('code-input');
  const errorBanner = document.getElementById('login-error');
  const errorText = document.getElementById('login-error-text');
  const statusLine = document.getElementById('login-status');
  const submitBtn = document.getElementById('login-submit');
  const headerCode = document.getElementById('header-code');
  const stepCounter = document.getElementById('step-counter');
  const instructionFrom = document.getElementById('instruction-from');
  const instructionTo = document.getElementById('instruction-to');
  const instructionArrow = document.getElementById('instruction-arrow');
  const threadUsedEl = document.getElementById('thread-used');
  const threadTotalEl = document.getElementById('thread-total');
  const threadProgressFill = document.getElementById('thread-progress-fill');
  const logoutBtn = document.getElementById('logout-btn');

  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const playBtn = document.getElementById('play-btn');
  const playIcon = document.getElementById('play-icon');
  const pauseIcon = document.getElementById('pause-icon');
  const speedSlider = document.getElementById('speed-slider');
  const speedValue = document.getElementById('speed-value');
  const completionBanner = document.getElementById('completion-banner');
  const completionTotal = document.getElementById('completion-total');

  const jumpPanel = document.getElementById('jump-panel');
  const jumpSlider = document.getElementById('jump-slider');
  const jumpValue = document.getElementById('jump-value');
  const jumpCancel = document.getElementById('jump-cancel');
  const jumpConfirm = document.getElementById('jump-confirm');

  const controlsTopRow = document.getElementById('controls-top-row');
  const langUkBtn = document.getElementById('lang-uk-btn');
  const langEnBtn = document.getElementById('lang-en-btn');
  const muteBtn = document.getElementById('mute-btn');
  const muteIconOn = document.getElementById('mute-icon-on');
  const muteIconOff = document.getElementById('mute-icon-off');
  const voiceFallbackNote = document.getElementById('voice-fallback-note');

  // Заповнюється при завантаженні /api/config (кількість пінів, діаметр
  // рами) — потрібне і для колеса, і для розрахунку довжини нитки.
  let publicConfig = { numPins: 240, pinCircleDiameterCm: 48 };

  let autoplayTimer = null;
  let lastSyncedStep = null; // останній крок, підтверджено відправлений на сервер

  const AssemblyApp = {
    state: {
      code: null,
      order: null, // { code, customerFirstName, stats, pins, progress }
      currentStep: 0, // індекс у order.pins; 0 = лише стартовий пін, ще нема "від"
      speedSeconds: 3,
      isPlaying: false,
    },

    /**
     * Викликається після успішного входу (свіжого чи автоматичного за
     * збереженим кодом). Визначає, з якого кроку починати: пріоритет —
     * локальний кеш цього пристрою (найсвіжіший), інакше — те, що знає
     * сервер.
     */
    showMainView() {
      viewLogin.style.display = 'none';
      viewMain.style.display = '';

      const o = AssemblyApp.state.order;
      headerCode.textContent = o.code;

      Wheel.init(publicConfig.numPins);

      const maxStep = o.pins.length - 1;
      const serverStep = o.progress ? Math.min(o.progress.currentStep, maxStep) : 0;
      const localStep = loadLocalProgress(o.code);

      const initialStep = (localStep !== null && localStep >= 0 && localStep <= maxStep)
        ? localStep
        : serverStep;

      AssemblyApp.state.currentStep = initialStep;
      AssemblyApp.state.speedSeconds = 3;
      lastSyncedStep = serverStep;

      speedSlider.value = '3';
      speedValue.textContent = '3с';
      jumpSlider.max = String(maxStep);
      completionTotal.textContent = String(maxStep);

      AssemblyApp.renderStep();

      // Якщо локальний кеш виявився попереду того, що знає сервер (типовий
      // випадок: людина продовжила складання, але останні кроки ще не
      // встигли синхронізуватись) — наздоганяємо сервер одразу, а не чекаємо
      // порогу в SYNC_EVERY_N_STEPS кроків.
      if (initialStep !== serverStep) {
        syncProgressToServer(initialStep, { force: true });
      }
    },

    /**
     * Перемальовує все, що залежить від поточного кроку: колесо, гігантську
     * інструкцію, лічильник, статистику нитки, стан кнопок керування.
     * Єдина точка входу для будь-якої зміни кроку.
     */
    renderStep() {
      const { order, currentStep } = AssemblyApp.state;
      const pins = order.pins;
      const maxStep = pins.length - 1;
      const toPin = pins[currentStep];
      const fromPin = currentStep > 0 ? pins[currentStep - 1] : null;

      Wheel.setStep(fromPin, toPin, publicConfig.numPins);

      stepCounter.innerHTML = currentStep === 0
        ? `Початок · пін <span class="step-current">${SectorUtils.pinToLabel(toPin)}</span>`
        : `Крок <span class="step-current">${currentStep}</span> з ${maxStep}`;

      if (fromPin === null) {
        instructionFrom.textContent = '';
        instructionArrow.style.visibility = 'hidden';
        instructionTo.textContent = SectorUtils.pinToLabel(toPin);
      } else {
        instructionArrow.style.visibility = 'visible';
        instructionFrom.textContent = SectorUtils.pinToLabel(fromPin);
        instructionTo.textContent = SectorUtils.pinToLabel(toPin);
      }

      const usedCm = SectorUtils.threadUsedCm(pins, currentStep, publicConfig.numPins, publicConfig.pinCircleDiameterCm);
      const totalCm = SectorUtils.totalThreadCm(pins, publicConfig.numPins, publicConfig.pinCircleDiameterCm);
      threadUsedEl.textContent = `${SectorUtils.cmToMeters(usedCm).toFixed(1)} м`;
      threadTotalEl.textContent = `${SectorUtils.cmToMeters(totalCm).toFixed(1)} м`;
      threadProgressFill.style.width = `${totalCm > 0 ? (usedCm / totalCm) * 100 : 0}%`;

      const atStart = currentStep === 0;
      const atEnd = currentStep === maxStep;
      prevBtn.disabled = atStart;
      nextBtn.disabled = atEnd;
      playBtn.disabled = atEnd;
      completionBanner.classList.toggle('is-active', atEnd);

      if (atEnd && AssemblyApp.state.isPlaying) {
        stopAutoplay();
      }

      if (atEnd) {
        // Завершення — момент, коли людина найімовірніше одразу закриє
        // вкладку. Порогова синхронізація (раз на SYNC_EVERY_N_STEPS кроків)
        // могла щойно пропустити цей останній крок як "занадто близький" до
        // попереднього — тому форсуємо, як і при паузі/переході.
        syncProgressToServer(currentStep, { force: true });
      }
    },

    /** Єдина точка зміни кроку — клампить межі, рендерить, зберігає прогрес. */
    goToStep(step) {
      const maxStep = AssemblyApp.state.order.pins.length - 1;
      const clamped = Math.max(0, Math.min(step, maxStep));
      AssemblyApp.state.currentStep = clamped;
      AssemblyApp.renderStep();
      saveLocalProgress(AssemblyApp.state.code, clamped);
      syncProgressToServer(clamped);
      speakCurrentStep();
    },

    next() {
      AssemblyApp.goToStep(AssemblyApp.state.currentStep + 1);
    },

    previous() {
      AssemblyApp.goToStep(AssemblyApp.state.currentStep - 1);
    },

    showLoginView() {
      viewMain.style.display = 'none';
      viewLogin.style.display = '';
    },

    logout() {
      stopAutoplay();
      localStorage.removeItem(LAST_CODE_KEY);
      AssemblyApp.state.code = null;
      AssemblyApp.state.order = null;
      codeInput.value = '';
      AssemblyApp.showLoginView();
      codeInput.focus();
    },
  };

  window.AssemblyApp = AssemblyApp;

  // ---------- Автоплей ----------
  function startAutoplay() {
    const { currentStep, order } = AssemblyApp.state;
    if (currentStep >= order.pins.length - 1) return; // нічого програвати далі

    AssemblyApp.state.isPlaying = true;
    playIcon.style.display = 'none';
    pauseIcon.style.display = '';
    playBtn.classList.add('is-playing');
    playBtn.setAttribute('aria-label', 'Поставити на паузу');

    autoplayTimer = setInterval(() => {
      const maxStep = AssemblyApp.state.order.pins.length - 1;
      if (AssemblyApp.state.currentStep >= maxStep) {
        stopAutoplay();
        return;
      }
      AssemblyApp.next();
    }, AssemblyApp.state.speedSeconds * 1000);
  }

  function stopAutoplay() {
    if (autoplayTimer) {
      clearInterval(autoplayTimer);
      autoplayTimer = null;
    }
    AssemblyApp.state.isPlaying = false;
    playIcon.style.display = '';
    pauseIcon.style.display = 'none';
    playBtn.classList.remove('is-playing');
    playBtn.setAttribute('aria-label', 'Відтворити автоматично');

    // Пауза — гарна нагода примусово підтвердити прогрес на сервері: людина
    // могла активно клепати кроки автоплеєм, і порогова синхронізація
    // (кожні SYNC_EVERY_N_STEPS) могла не встигнути на останніх кроках.
    if (AssemblyApp.state.code) {
      syncProgressToServer(AssemblyApp.state.currentStep, { force: true });
    }
  }

  function restartAutoplayIfPlaying() {
    if (!AssemblyApp.state.isPlaying) return;
    clearInterval(autoplayTimer);
    autoplayTimer = setInterval(() => {
      const maxStep = AssemblyApp.state.order.pins.length - 1;
      if (AssemblyApp.state.currentStep >= maxStep) {
        stopAutoplay();
        return;
      }
      AssemblyApp.next();
    }, AssemblyApp.state.speedSeconds * 1000);
  }

  playBtn.addEventListener('click', () => {
    if (AssemblyApp.state.isPlaying) {
      stopAutoplay();
    } else {
      startAutoplay();
    }
  });

  prevBtn.addEventListener('click', () => {
    if (AssemblyApp.state.isPlaying) stopAutoplay();
    AssemblyApp.previous();
  });

  nextBtn.addEventListener('click', () => {
    if (AssemblyApp.state.isPlaying) stopAutoplay();
    AssemblyApp.next();
  });

  speedSlider.addEventListener('input', () => {
    const seconds = Number(speedSlider.value);
    AssemblyApp.state.speedSeconds = seconds;
    speedValue.textContent = `${seconds}с`;
    restartAutoplayIfPlaying();
  });

  // ---------- Панель "перейти на крок" ----------
  function openJumpPanel() {
    if (AssemblyApp.state.isPlaying) stopAutoplay();
    jumpSlider.value = String(AssemblyApp.state.currentStep);
    jumpValue.textContent = String(AssemblyApp.state.currentStep);
    jumpPanel.classList.add('is-open');
  }

  function closeJumpPanel() {
    jumpPanel.classList.remove('is-open');
  }

  stepCounter.addEventListener('click', openJumpPanel);

  jumpSlider.addEventListener('input', () => {
    jumpValue.textContent = jumpSlider.value;
  });

  jumpCancel.addEventListener('click', closeJumpPanel);

  jumpConfirm.addEventListener('click', () => {
    const target = Number(jumpSlider.value);
    closeJumpPanel();
    AssemblyApp.goToStep(target);
    syncProgressToServer(target, { force: true });
  });

  logoutBtn.addEventListener('click', AssemblyApp.logout);

  // ---------- Голосовий асистент ----------
  const VOICE_LANG_KEY = 'sa_voice_lang';
  const VOICE_MUTED_KEY = 'sa_voice_muted';
  let fallbackNoteTimer = null;

  function speakCurrentStep() {
    if (!VoiceAssistant.isSupported) return;
    const { order, currentStep } = AssemblyApp.state;
    if (!order) return;
    const toPin = order.pins[currentStep];
    const fromPin = currentStep > 0 ? order.pins[currentStep - 1] : null;
    VoiceAssistant.speak(fromPin, toPin);
  }

  function setLangButtonsActive(lang) {
    langUkBtn.classList.toggle('is-active', lang === 'uk');
    langEnBtn.classList.toggle('is-active', lang === 'en');
  }

  function setMuteIcon(muted) {
    muteIconOn.style.display = muted ? 'none' : '';
    muteIconOff.style.display = muted ? '' : 'none';
    muteBtn.setAttribute('aria-label', muted ? 'Увімкнути голос' : 'Вимкнути голос');
  }

  if (!VoiceAssistant.isSupported) {
    // Пристрій/браузер не підтримує Web Speech API (рідкість, але буває,
    // особливо в старих Android WebView) — ховаємо всю панель, а не
    // показуємо кнопки, які нічого не роблять.
    controlsTopRow.classList.add('is-hidden');
  } else {
    const savedLang = localStorage.getItem(VOICE_LANG_KEY);
    const initialLang = savedLang === 'en' ? 'en' : 'uk';
    VoiceAssistant.setLanguage(initialLang);
    setLangButtonsActive(initialLang);

    const savedMuted = localStorage.getItem(VOICE_MUTED_KEY) === '1';
    VoiceAssistant.setMuted(savedMuted);
    setMuteIcon(savedMuted);

    VoiceAssistant.onFallback(() => {
      voiceFallbackNote.textContent = 'Голос UA недоступний на пристрої — використано EN';
      voiceFallbackNote.classList.add('is-visible');
      clearTimeout(fallbackNoteTimer);
      fallbackNoteTimer = setTimeout(() => voiceFallbackNote.classList.remove('is-visible'), 5000);
    });

    function selectLang(lang) {
      VoiceAssistant.setLanguage(lang);
      setLangButtonsActive(lang);
      localStorage.setItem(VOICE_LANG_KEY, lang);
      // Одразу промовляємо поточний крок новою мовою — звукове підтвердження,
      // що перемикач реально спрацював, без зайвого тексту на екрані.
      if (AssemblyApp.state.order) speakCurrentStep();
    }

    langUkBtn.addEventListener('click', () => selectLang('uk'));
    langEnBtn.addEventListener('click', () => selectLang('en'));

    muteBtn.addEventListener('click', () => {
      const nowMuted = !VoiceAssistant.isMuted();
      VoiceAssistant.setMuted(nowMuted);
      setMuteIcon(nowMuted);
      localStorage.setItem(VOICE_MUTED_KEY, nowMuted ? '1' : '0');
    });
  }

  // ---------- Публічний конфіг ----------
  const configPromise = fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => { publicConfig = { ...publicConfig, ...cfg }; })
    .catch(() => {
      /* лишаємось на дефолтних 240/48 см, якщо конфіг недоступний */
    });

  // ---------- localStorage: прогрес конкретного замовлення ----------
  function progressKey(code) {
    return `sa_progress_${code}`;
  }

  function saveLocalProgress(code, step) {
    if (!code) return;
    try {
      localStorage.setItem(progressKey(code), JSON.stringify({ step, updatedAt: Date.now() }));
    } catch (e) {
      // localStorage може бути недоступний (приватний режим у деяких
      // браузерах, вичерпана квота) — це не критично, сервер-синхронізація
      // нижче все одно підстрахує прогрес.
    }
  }

  function loadLocalProgress(code) {
    try {
      const raw = localStorage.getItem(progressKey(code));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Number.isInteger(parsed.step) ? parsed.step : null;
    } catch (e) {
      return null;
    }
  }

  // ---------- Синхронізація прогресу з сервером (підстраховка) ----------
  function syncProgressToServer(step, { force = false } = {}) {
    const { code } = AssemblyApp.state;
    if (!code) return;

    const farEnough = lastSyncedStep === null || Math.abs(step - lastSyncedStep) >= SYNC_EVERY_N_STEPS;
    if (!force && !farEnough) return;

    lastSyncedStep = step;
    fetch(`/api/assembly/${encodeURIComponent(code)}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step }),
      keepalive: true, // дає запиту шанс завершитись, навіть якщо вкладку вже закривають
    }).catch(() => {
      // Best-effort: якщо не вдалось — просто спробуємо на наступному кроці/
      // события. localStorage тим часом лишається джерелом істини для ЦЬОГО
      // пристрою, тож людина нічого не втрачає навіть при збої мережі.
    });
  }

  /** Використовує sendBeacon — найнадійніший спосіб відправити останній
   *  прогрес саме в момент закриття/згортання вкладки. */
  function beaconSyncProgress() {
    const { code, currentStep } = AssemblyApp.state;
    if (!code) return;
    try {
      const blob = new Blob([JSON.stringify({ step: currentStep })], { type: 'application/json' });
      navigator.sendBeacon(`/api/assembly/${encodeURIComponent(code)}/progress`, blob);
    } catch (e) {
      /* best effort */
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') beaconSyncProgress();
  });
  window.addEventListener('pagehide', beaconSyncProgress);

  // ---------- Допоміжні функції UI (вхід) ----------
  function normalizeCode(raw) {
    return String(raw || '').trim().toUpperCase();
  }

  function hideError() {
    errorBanner.classList.remove('is-active');
    codeInput.classList.remove('has-error');
  }

  function showError(message) {
    errorText.textContent = message;
    errorBanner.classList.add('is-active');
    codeInput.classList.add('has-error');
  }

  function setLoading(isLoading, message) {
    statusLine.classList.toggle('is-active', isLoading);
    if (message) document.getElementById('login-status-text').textContent = message;
    submitBtn.disabled = isLoading;
    codeInput.disabled = isLoading;
  }

  // ---------- Запит до бекенду ----------
  async function fetchOrder(code) {
    const res = await fetch(`/api/assembly/${encodeURIComponent(code)}`);
    const json = await res.json();
    if (!res.ok || !json.ok) {
      const err = new Error(json.error || 'Не вдалося завантажити замовлення.');
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async function attemptLogin(code, { silent = false } = {}) {
    hideError();

    if (!CODE_RE.test(code)) {
      if (!silent) showError('Перевірте формат коду — має виглядати як SA-20260716-4F2A.');
      return false;
    }

    setLoading(true, silent ? 'Перевіряємо збережений код…' : 'Завантажуємо інструкцію…');

    try {
      const [order] = await Promise.all([fetchOrder(code), configPromise]);
      AssemblyApp.state.code = code;
      AssemblyApp.state.order = order;
      localStorage.setItem(LAST_CODE_KEY, code);
      AssemblyApp.showMainView();
      return true;
    } catch (e) {
      // Якщо це була тиха спроба за збереженим кодом (наприклад код більше
      // не існує) — просто прибираємо його й мовчки показуємо форму входу,
      // без лякання людини технічною помилкою при заході на сайт.
      if (silent) {
        localStorage.removeItem(LAST_CODE_KEY);
      } else if (e.status === 429) {
        showError('Забагато спроб. Зачекайте кілька хвилин і спробуйте ще раз.');
      } else if (e.status === 404) {
        showError('Код не знайдено. Перевірте, чи правильно його введено.');
      } else {
        showError('Не вдалося перевірити код. Перевірте інтернет-з\'єднання і спробуйте ще раз.');
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  // ---------- Обробники входу ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    attemptLogin(normalizeCode(codeInput.value));
  });

  codeInput.addEventListener('input', () => {
    // Автоматично вирівнюємо в верхній регістр по мірі набору — приємніше,
    // ніж чекати сабміту, щоб побачити код так, як він виглядає насправді.
    const cursorAtEnd = codeInput.selectionStart === codeInput.value.length;
    codeInput.value = codeInput.value.toUpperCase();
    if (cursorAtEnd) {
      codeInput.setSelectionRange(codeInput.value.length, codeInput.value.length);
    }
    hideError();
  });

  // ---------- Ініціалізація ----------
  (function init() {
    const params = new URLSearchParams(window.location.search);
    const codeFromUrl = normalizeCode(params.get('code'));
    const codeFromStorage = normalizeCode(localStorage.getItem(LAST_CODE_KEY));

    if (codeFromUrl && CODE_RE.test(codeFromUrl)) {
      // Клієнт перейшов за посиланням з кодом (наприклад із SMS/email) —
      // підставляємо і одразу пробуємо увійти.
      codeInput.value = codeFromUrl;
      attemptLogin(codeFromUrl);
      return;
    }

    if (codeFromStorage && CODE_RE.test(codeFromStorage)) {
      // Тиха спроба увійти за раніше збереженим кодом. Форма входу вже
      // намальована під капотом на випадок, якщо це не вдасться.
      codeInput.value = codeFromStorage;
      attemptLogin(codeFromStorage, { silent: true });
      return;
    }

    codeInput.focus();
  })();
})();
