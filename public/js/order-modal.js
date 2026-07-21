// public/js/order-modal.js
//
// Модалка оформлення замовлення. Викликається як window.openOrderModal(session),
// де session = { sessionId, stats, background } — те, що повертає /api/generate
// (див. app.js). Сама відправляє POST /api/order і показує результат.

(function () {
  'use strict';

  const overlay = document.getElementById('order-modal-overlay');
  const closeBtn = document.getElementById('order-modal-close');
  const doneBtn = document.getElementById('order-modal-done-btn');
  const formView = document.getElementById('order-modal-form-view');
  const successView = document.getElementById('order-modal-success-view');
  const form = document.getElementById('order-form');
  const submitBtn = document.getElementById('order-submit-btn');
  const errorBanner = document.getElementById('order-error-banner');
  const errorText = document.getElementById('order-error-text');
  const orderNumberDisplay = document.getElementById('order-number-display');

  const thumb = document.getElementById('order-modal-thumb');
  const linesEl = document.getElementById('order-modal-lines');
  const metersEl = document.getElementById('order-modal-meters');

  const countryCodeSelect = document.getElementById('f-countryCode');
  const phoneLocalInput = document.getElementById('f-phoneLocal');

  let currentSession = null;
  let lastFocusedBeforeModal = null;

  // ---------- Відкриття / закриття ----------
  function openModal(session) {
    currentSession = session;
    if (!session || !session.sessionId) return;

    thumb.src = `/api/generate/preview/${session.sessionId}`;
    linesEl.textContent = session.stats ? session.stats.lines : '—';
    metersEl.textContent = session.stats ? session.stats.metersWithMargin : '—';

    form.reset();
    clearAllFieldErrors();
    hideOrderError();
    formView.style.display = '';
    successView.style.display = 'none';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Підтвердити замовлення';

    lastFocusedBeforeModal = document.activeElement;
    overlay.classList.add('is-active');
    document.body.style.overflow = 'hidden';
    const firstField = document.getElementById('f-fullName');
    if (firstField) firstField.focus();
  }
  window.openOrderModal = openModal;

  function closeModal() {
    overlay.classList.remove('is-active');
    document.body.style.overflow = '';
    if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
      lastFocusedBeforeModal.focus();
    }
  }

  closeBtn.addEventListener('click', closeModal);
  doneBtn.addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('is-active')) {
      closeModal();
    }
    // Простий фокус-трап всередині модалки
    if (e.key === 'Tab' && overlay.classList.contains('is-active')) {
      const focusable = overlay.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // ---------- Валідація (дзеркалить server/services/validateOrder.js) ----------
  const NAME_RE = /^[A-Za-z][A-Za-z\s'-]{1,79}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const PHONE_RE = /^\+?[1-9]\d{6,14}$/;
  const ZIP_RE = /^[A-Za-z0-9][A-Za-z0-9\s-]{1,11}$/;

  function clearAllFieldErrors() {
    form.querySelectorAll('.field-error').forEach((el) => (el.textContent = ''));
    form.querySelectorAll('.has-error').forEach((el) => el.classList.remove('has-error'));
  }

  function setFieldError(name, message) {
    const el = form.querySelector(`[data-error-for="${name}"]`);
    if (el) el.textContent = message || '';
    const input = form.querySelector(`[name="${name}"]`) || (name === 'phone' ? phoneLocalInput : null);
    if (input) input.classList.toggle('has-error', Boolean(message));
  }

  function hideOrderError() {
    errorBanner.classList.remove('is-active');
    errorText.textContent = '';
  }

  function showOrderError(message) {
    errorText.textContent = message;
    errorBanner.classList.add('is-active');
  }

  function getFullPhone() {
    const code = countryCodeSelect.value.trim();
    const local = phoneLocalInput.value.trim().replace(/[\s()-]/g, '');
    return `${code}${local}`;
  }

  function validateClientSide(data) {
    clearAllFieldErrors();
    let valid = true;

    if (!NAME_RE.test(data.fullName)) {
      setFieldError('fullName', "Лише латинські літери, мінімум 2 символи.");
      valid = false;
    }
    if (!PHONE_RE.test(data.phone)) {
      setFieldError('phone', 'Перевірте номер телефону.');
      valid = false;
    }
    if (!EMAIL_RE.test(data.email)) {
      setFieldError('email', 'Некоректний email.');
      valid = false;
    }
    if (!data.country) {
      setFieldError('country', "Обов'язкове поле.");
      valid = false;
    }
    if (!data.city) {
      setFieldError('city', "Обов'язкове поле.");
      valid = false;
    }
    if (!ZIP_RE.test(data.zip)) {
      setFieldError('zip', 'Некоректний індекс.');
      valid = false;
    }
    if (!data.addressLine1) {
      setFieldError('addressLine1', "Обов'язкове поле.");
      valid = false;
    }

    return valid;
  }

  // ---------- Відправка ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    hideOrderError();

    if (!currentSession || !currentSession.sessionId) {
      showOrderError("Сесія генерації втрачена. Закрийте вікно й створіть прев'ю ще раз.");
      return;
    }

    const data = {
      sessionId: currentSession.sessionId,
      fullName: document.getElementById('f-fullName').value.trim(),
      phone: getFullPhone(),
      email: document.getElementById('f-email').value.trim(),
      country: document.getElementById('f-country').value.trim(),
      city: document.getElementById('f-city').value.trim(),
      zip: document.getElementById('f-zip').value.trim(),
      addressLine1: document.getElementById('f-address1').value.trim(),
      addressLine2: document.getElementById('f-address2').value.trim(),
    };

    if (!validateClientSide(data)) {
      showOrderError('Перевірте позначені поля нижче.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Надсилаємо…';

    fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok || !json.ok) {
          const err = new Error(json.error || 'Не вдалося оформити замовлення.');
          err.fieldErrors = json.fieldErrors;
          throw err;
        }
        return json;
      })
      .then((json) => {
        orderNumberDisplay.textContent = json.orderNumber;
        formView.style.display = 'none';
        successView.style.display = '';
      })
      .catch((err) => {
        if (err.fieldErrors) {
          Object.entries(err.fieldErrors).forEach(([field, message]) => setFieldError(field, message));
        }
        showOrderError(err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Підтвердити замовлення';
      });
  });
})();
