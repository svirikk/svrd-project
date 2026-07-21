// public/js/app.js
//
// Логіка Generator Card: drag&drop -> Cropper.js -> POST /api/generate ->
// показ результату. Кнопка "Замовити" в кінці викликає window.openOrderModal,
// яку визначає модалка замовлення (додається в Частині 5). Якщо її ще нема —
// просто нічого не робимо, замість падіння з помилкою.

(function () {
  'use strict';

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const cropStage = document.getElementById('crop-stage');
  const cropImage = document.getElementById('crop-image');
  const resultStage = document.getElementById('result-stage');
  const resultImage = document.getElementById('result-image');
  const ctaArea = document.getElementById('cta-area');
  const statusLine = document.getElementById('status-line');
  const statusText = document.getElementById('status-text');
  const warningBanner = document.getElementById('warning-banner');
  const warningText = document.getElementById('warning-text');
  const errorBanner = document.getElementById('error-banner');
  const errorText = document.getElementById('error-text');
  const statsRow = document.getElementById('stats-row');
  const statLines = document.getElementById('stat-lines');
  const statMeters = document.getElementById('stat-meters');
  const statPins = document.getElementById('stat-pins');
  const pinRingGroup = document.getElementById('pin-ring-dots');

  const PIN_RING_COUNT = 48; // виключно візуальне кільце, не пов'язане з реальною кількістю пінів продукту

  let cropper = null;
  let publicConfig = { maxUploadMb: 15, allowedMime: ['image/jpeg', 'image/png', 'image/webp'], numPins: 240 };
  let session = null; // { sessionId, stats, background }

  // ---------- Публічний конфіг (щоб не хардкодити ліміти, які може змінити бекенд) ----------
  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      publicConfig = cfg;
      if (statPins) statPins.textContent = cfg.numPins;
    })
    .catch(() => {
      /* лишаємось на дефолтних значеннях, якщо конфіг з якоїсь причини недоступний */
    });

  // ---------- Сигнатурне кільце пінів навколо дропзони ----------
  function drawPinRing() {
    const cx = 50, cy = 50, rOuter = 49, rInner = 45.5;
    let svg = '';
    for (let i = 0; i < PIN_RING_COUNT; i++) {
      const angle = (i / PIN_RING_COUNT) * Math.PI * 2;
      const x1 = (cx + rInner * Math.cos(angle)).toFixed(2);
      const y1 = (cy + rInner * Math.sin(angle)).toFixed(2);
      const x2 = (cx + rOuter * Math.cos(angle)).toFixed(2);
      const y2 = (cy + rOuter * Math.sin(angle)).toFixed(2);
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#3a3840" stroke-width="0.6" />`;
    }
    pinRingGroup.innerHTML = svg;
  }
  drawPinRing();

  // ---------- Декоративна ілюстрація набору (секція "Продукт") ----------
  (function drawKitIllustration() {
    const pinsGroup = document.getElementById('kit-pins');
    const threadsGroup = document.getElementById('kit-threads');
    if (!pinsGroup || !threadsGroup) return;

    const cx = 160, cy = 160, r = 118;
    const count = 36;
    let pinsSvg = '';
    const points = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      points.push([x, y]);
      pinsSvg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#c6a15b" fill-opacity="0.6" />`;
    }
    pinsGroup.innerHTML = pinsSvg;

    let threadsSvg = '';
    for (let i = 0; i < 22; i++) {
      const a = Math.floor(Math.random() * count);
      const b = (a + 10 + Math.floor(Math.random() * (count - 20))) % count;
      const [x1, y1] = points[a];
      const [x2, y2] = points[b];
      threadsSvg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#e8e6df" stroke-width="0.5" stroke-opacity="0.5" />`;
    }
    threadsGroup.innerHTML = threadsSvg;
  })();

  function pulseThreadSweep() {
    // Коротка анімація-фінал: кілька "ниток" між випадковими пінами, що
    // проявляються послідовно. Один раз, після успішної генерації — не
    // безкінечна декорація.
    const cx = 50, cy = 50, r = 45.5;
    const chords = [];
    for (let i = 0; i < 7; i++) {
      const a = Math.floor(Math.random() * PIN_RING_COUNT);
      let b = (a + 8 + Math.floor(Math.random() * (PIN_RING_COUNT - 16))) % PIN_RING_COUNT;
      chords.push([a, b]);
    }
    let svg = '';
    chords.forEach(([a, b], idx) => {
      const angleA = (a / PIN_RING_COUNT) * Math.PI * 2;
      const angleB = (b / PIN_RING_COUNT) * Math.PI * 2;
      const x1 = (cx + r * Math.cos(angleA)).toFixed(2);
      const y1 = (cy + r * Math.sin(angleA)).toFixed(2);
      const x2 = (cx + r * Math.cos(angleB)).toFixed(2);
      const y2 = (cy + r * Math.sin(angleB)).toFixed(2);
      svg += `<line class="thread-sweep" style="animation-delay:${idx * 80}ms" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;
    });
    pinRingGroup.insertAdjacentHTML('beforeend', svg);
  }

  // ---------- Допоміжні функції UI ----------
  function hideBanners() {
    warningBanner.classList.remove('is-active');
    errorBanner.classList.remove('is-active');
  }

  function showError(message) {
    hideBanners();
    errorText.textContent = message;
    errorBanner.classList.add('is-active');
  }

  function showWarning(message) {
    warningText.textContent = message;
    warningBanner.classList.add('is-active');
  }

  function setStage(stage) {
    // stage: 'drop' | 'crop' | 'result'
    dropzone.classList.toggle('is-hidden', stage !== 'drop');
    cropStage.classList.toggle('is-active', stage === 'crop');
    resultStage.classList.toggle('is-active', stage === 'result');
  }

  const STATUS_MESSAGES = [
    'Готуємо фото…',
    'Аналізуємо риси обличчя…',
    'Розраховуємо оптимальний фон…',
    'Плетемо нитку між пінами…',
    'Майже готово…',
  ];

  let statusInterval = null;

  function startStatus() {
    let i = 0;
    statusText.textContent = STATUS_MESSAGES[0];
    statusLine.classList.add('is-active');
    statusInterval = setInterval(() => {
      i = (i + 1) % STATUS_MESSAGES.length;
      statusText.textContent = STATUS_MESSAGES[i];
    }, 3000);
  }

  function stopStatus() {
    clearInterval(statusInterval);
    statusLine.classList.remove('is-active');
  }

  function renderGenerateButton() {
    ctaArea.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.id = 'generate-btn';
    btn.textContent = "Створити прев'ю";
    btn.addEventListener('click', handleGenerate);
    ctaArea.appendChild(btn);
  }

  function renderOrderButtons() {
    ctaArea.innerHTML = '';

    const orderBtn = document.createElement('button');
    orderBtn.className = 'btn btn-primary';
    orderBtn.textContent = 'Замовити цю картину';
    orderBtn.addEventListener('click', () => {
      if (typeof window.openOrderModal === 'function') {
        window.openOrderModal(session);
      }
      // Якщо модалку замовлення ще не додано (буде в наступній частині) —
      // кнопка поки що просто нічого не робить, без помилки в консолі.
    });

    const row = document.createElement('div');
    row.className = 'btn-row';

    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn btn-ghost';
    retryBtn.textContent = 'Інше фото';
    retryBtn.addEventListener('click', resetAll);

    ctaArea.appendChild(orderBtn);
    ctaArea.appendChild(row);
    row.appendChild(retryBtn);
  }

  function resetAll() {
    session = null;
    hideBanners();
    statsRow.style.display = 'none';
    if (cropper) {
      cropper.destroy();
      cropper = null;
    }
    fileInput.value = '';
    setStage('drop');
    renderGenerateButtonDisabled();
    drawPinRing(); // прибираємо анімовані акорди, якщо були
  }

  function renderGenerateButtonDisabled() {
    ctaArea.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.id = 'generate-btn';
    btn.textContent = 'Спершу оберіть фото';
    btn.disabled = true;
    ctaArea.appendChild(btn);
  }

  // ---------- Обробка вибору файлу ----------
  function validateFile(file) {
    if (!publicConfig.allowedMime.includes(file.type)) {
      return 'Непідтримуваний формат. Завантажте JPG, PNG або WEBP.';
    }
    const maxBytes = publicConfig.maxUploadMb * 1024 * 1024;
    if (file.size > maxBytes) {
      return `Файл завеликий. Максимум ${publicConfig.maxUploadMb} МБ.`;
    }
    return null;
  }

  function handleFile(file) {
    hideBanners();
    const err = validateFile(file);
    if (err) {
      showError(err);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      cropImage.src = e.target.result;
      setStage('crop');

      if (cropper) cropper.destroy();
      cropper = new Cropper(cropImage, {
        aspectRatio: 1,
        viewMode: 1,
        dragMode: 'move',
        background: false,
        autoCropArea: 1,
        cropBoxMovable: false,
        cropBoxResizable: false,
        toggleDragModeOnDblclick: false,
      });

      renderGenerateButton();
    };
    reader.readAsDataURL(file);
  }

  // ---------- Генерація ----------
  function handleGenerate() {
    if (!cropper) return;

    hideBanners();
    setStage('crop'); // лишаємось на кроп-стадії, поки триває запит
    startStatus();

    const btn = document.getElementById('generate-btn');
    if (btn) btn.disabled = true;

    cropper.getCroppedCanvas({ width: 1024, height: 1024, imageSmoothingQuality: 'high' }).toBlob(
      (blob) => {
        if (!blob) {
          stopStatus();
          showError('Не вдалося обробити фото. Спробуйте інше зображення.');
          if (btn) btn.disabled = false;
          return;
        }

        const formData = new FormData();
        formData.append('photo', blob, 'cropped.jpg');

        fetch('/api/generate', { method: 'POST', body: formData })
          .then(async (res) => {
            const data = await res.json();
            if (!res.ok || !data.ok) {
              throw new Error(data.error || 'Не вдалося згенерувати прев\'ю.');
            }
            return data;
          })
          .then((data) => {
            session = { sessionId: data.sessionId, stats: data.stats, background: data.background };

            resultImage.src = data.previewUrl;
            setStage('result');

            statLines.textContent = data.stats.lines;
            statMeters.textContent = data.stats.metersWithMargin;
            statsRow.style.display = 'flex';

            if (data.background && data.background.warningLevel && data.background.warningLevel !== 'none') {
              showWarning(data.background.warningMessage);
            }

            renderOrderButtons();
            pulseThreadSweep();
          })
          .catch((e) => {
            setStage('crop');
            showError(e.message || 'Щось пішло не так. Спробуйте ще раз.');
            if (btn) btn.disabled = false;
          })
          .finally(() => {
            stopStatus();
          });
      },
      'image/jpeg',
      0.92
    );
  }

  // ---------- Drag & drop / вибір файлу ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) {
      handleFile(fileInput.files[0]);
    }
  });

  ['dragover', 'dragenter'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    })
  );

  ['dragleave', 'dragend'].forEach((evt) =>
    dropzone.addEventListener(evt, () => dropzone.classList.remove('is-dragover'))
  );

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // Ініціальний стан кнопки
  renderGenerateButtonDisabled();

  // Ціна показана в двох місцях (секція продукту + модалка замовлення) —
  // синхронізуємо з одного джерела (data-price), щоб не розійшлись.
  const priceSource = document.querySelector('[data-price]');
  if (priceSource) {
    document.querySelectorAll('[data-price-copy]').forEach((el) => {
      el.textContent = `₾${priceSource.textContent}`;
    });
  }
})();
