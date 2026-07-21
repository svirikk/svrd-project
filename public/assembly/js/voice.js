// public/assembly/js/voice.js
//
// Голосовий асистент на Web Speech API (window.speechSynthesis).
// Формує фразу типу "Від сектора Бі, дванадцять, до сектора Ді, сорок п'ять."
// замість незрозумілого "B12 D45" — саме так, як просив клієнт: числа й
// сектори промовляються словами, а не побуквено.
//
// Підтримує укр/англ з чесним фолбеком: якщо на пристрої немає української
// системної озвучки (типово поза macOS/iOS з увімкненою укр. мовою), тихо
// перемикається на англійську ОБОХ — і голос, і текст — щоб не читати
// українську фразу англійським голосом (звучало б незрозуміло), і повідомляє
// про це через onFallback-колбек.

(function () {
  'use strict';

  const isSupported = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

  // ---------- Числа словами (1-240 — тепер наскрізна нумерація, не 1-60) ----------

  const UK_ONES = ['', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять", 'десять',
    'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять', "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
  const UK_TENS = { 20: 'двадцять', 30: 'тридцять', 40: 'сорок', 50: "п'ятдесят", 60: 'шістдесят', 70: 'сімдесят', 80: 'вісімдесят', 90: "дев'яносто" };
  const UK_HUNDREDS = { 100: 'сто', 200: 'двісті' };

  const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const EN_TENS = { 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety' };
  const EN_HUNDREDS = { 100: 'one hundred', 200: 'two hundred' };

  /** Числа 1-99 словами (допоміжна — використовується і як самостійна форма, і як "залишок" після сотень). */
  function twoDigitsUK(n) {
    if (n === 0) return '';
    if (n <= 19) return UK_ONES[n];
    const tens = Math.floor(n / 10) * 10;
    const ones = n % 10;
    return ones === 0 ? UK_TENS[tens] : `${UK_TENS[tens]} ${UK_ONES[ones]}`;
  }

  function twoDigitsEN(n) {
    if (n === 0) return '';
    if (n <= 19) return EN_ONES[n];
    const tens = Math.floor(n / 10) * 10;
    const ones = n % 10;
    return ones === 0 ? EN_TENS[tens] : `${EN_TENS[tens]}-${EN_ONES[ones]}`;
  }

  function numberToWordsUK(n) {
    if (n <= 99) return twoDigitsUK(n);
    const hundreds = Math.floor(n / 100) * 100; // 100 або 200 (максимум у нас 240)
    const rest = n % 100;
    return rest === 0 ? UK_HUNDREDS[hundreds] : `${UK_HUNDREDS[hundreds]} ${twoDigitsUK(rest)}`;
  }

  function numberToWordsEN(n) {
    if (n <= 99) return twoDigitsEN(n);
    const hundreds = Math.floor(n / 100) * 100;
    const rest = n % 100;
    return rest === 0 ? EN_HUNDREDS[hundreds] : `${EN_HUNDREDS[hundreds]} ${twoDigitsEN(rest)}`;
  }

  // ---------- Фонетика секторних літер ----------
  // Латинські A/B/C/D на екрані лишаються як є (Частина 3) — тут лише те,
  // ЯК їх промовити. Англійська TTS читає окремі великі літери природно
  // (voice сама вимовляє "A" як "ей"), а для української явно прописуємо
  // фонетичне звучання — інакше рушій може прочитати "A" незрозуміло чи
  // переключитись у "буквений" режим на кожній літері.
  const SECTOR_PHONETIC = {
    uk: { A: 'Ей', B: 'Бі', C: 'Сі', D: 'Ді' },
    en: { A: 'A', B: 'B', C: 'C', D: 'D' },
  };

  function buildSpeechText(fromPin, toPin, lang) {
    const to = window.SectorUtils.pinToSector(toPin);
    const toLetter = SECTOR_PHONETIC[lang][to.letter];
    const toNum = lang === 'uk' ? numberToWordsUK(to.number) : numberToWordsEN(to.number);

    if (fromPin === null || fromPin === undefined) {
      return lang === 'uk'
        ? `Початок. Пін сектор ${toLetter}, ${toNum}.`
        : `Start. Pin sector ${toLetter}, ${toNum}.`;
    }

    const from = window.SectorUtils.pinToSector(fromPin);
    const fromLetter = SECTOR_PHONETIC[lang][from.letter];
    const fromNum = lang === 'uk' ? numberToWordsUK(from.number) : numberToWordsEN(from.number);

    return lang === 'uk'
      ? `Від сектора ${fromLetter}, ${fromNum}, до сектора ${toLetter}, ${toNum}.`
      : `From sector ${fromLetter}, ${fromNum}, to sector ${toLetter}, ${toNum}.`;
  }

  // ---------- Обгортка над Web Speech API ----------

  let voicesCache = [];
  let currentLang = 'uk';
  let muted = false;
  let fallbackCallback = null;

  function loadVoices() {
    if (!isSupported) return;
    voicesCache = window.speechSynthesis.getVoices();
  }

  if (isSupported) {
    loadVoices();
    // Список голосів вантажиться асинхронно (особливо в Chrome) — перший
    // виклик getVoices() може повернути порожній масив.
    if ('onvoiceschanged' in window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  function pickVoice(lang) {
    if (!voicesCache.length) return null;
    const prefix = lang === 'uk' ? 'uk' : 'en';
    return voicesCache.find((v) => v.lang && v.lang.toLowerCase().startsWith(prefix)) || null;
  }

  /**
   * Промовляє крок "від піна до піна". fromPin === null означає стартовий
   * крок (без "від"). Мовчить, якщо асистент вимкнено чи API не підтримується.
   */
  function speak(fromPin, toPin) {
    if (!isSupported || muted) return;

    let effectiveLang = currentLang;
    let voice = pickVoice(effectiveLang);

    if (!voice && effectiveLang === 'uk') {
      effectiveLang = 'en';
      voice = pickVoice('en');
      if (fallbackCallback) fallbackCallback('uk-unavailable');
    }

    const text = buildSpeechText(fromPin, toPin, effectiveLang);
    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = effectiveLang === 'uk' ? 'uk-UA' : 'en-US';
    if (voice) utterance.voice = voice;
    utterance.rate = 0.98;
    utterance.pitch = 1.0;

    // Не даємо старим репліками накопичуватись у черзі — при швидкому
    // автоплеї нова репліка завжди повинна перекривати попередню, щоб
    // голос не "відставав" від того, що людина вже бачить на екрані.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  window.VoiceAssistant = {
    isSupported,
    speak,
    setLanguage(lang) {
      currentLang = lang === 'en' ? 'en' : 'uk';
    },
    getLanguage() {
      return currentLang;
    },
    setMuted(value) {
      muted = Boolean(value);
      if (muted && isSupported) window.speechSynthesis.cancel();
    },
    isMuted() {
      return muted;
    },
    onFallback(cb) {
      fallbackCallback = cb;
    },
    // Експортуємо для юніт-тестів — не використовується в основному потоці застосунку.
    _internal: { numberToWordsUK, numberToWordsEN, buildSpeechText },
  };
})();
