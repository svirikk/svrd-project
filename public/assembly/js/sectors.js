// public/assembly/js/sectors.js
//
// Чисті функції без залежності від DOM — легко тестувати ізольовано.
// Підключається окремим <script> тегом і виставляє window.SectorUtils.

(function () {
  'use strict';

  const NUM_PINS = 240; // фіксовано під продукт — 240 пінів на рамі
  const SECTOR_SIZE = 60;
  // G-порядок (глобальний номер 1-240) — просто послідовно A,B,C,D за
  // годинниковою стрілкою. НЕ плутати з масивом у wheel.js — там інший,
  // raw-індексований масив для статичних підписів дуг на колесі; обидва
  // дають однакову літеру для однієї й тієї ж фізичної точки (перевірено
  // тестами), але влаштовані по-різному й змінюються незалежно.
  const SECTOR_LETTERS = ['A', 'B', 'C', 'D'];

  /**
   * Мапить абсолютний індекс піна (0-239, як його видає C++ рушій) у
   * секторну нотацію з наскрізною нумерацією 1-240 за годинниковою
   * стрілкою (а не окремим лічильником 1-60 на кожен сектор).
   *
   * Геометрія (див. wheel.js): raw-індекс 0 лежить праворуч (3 години),
   * і ЗРОСТАННЯ raw-індексу рухається ПРОТИ годинникової стрілки
   * (право->верх->ліво->низ). Тобто рух ЗА годинниковою — це ЗМЕНШЕННЯ
   * raw-індексу.
   *
   * Глобальний номер G=1 закріплено за raw=119 — це піна сектору A
   * (raw 60-119), найближча до лівої точки кола (не до верхньої, як
   * було б, якби відлік ішов від raw=60). Далі G зростає за годинниковою
   * стрілкою (тобто в напрямку ЗМЕНШЕННЯ raw) аж до G=240.
   *
   * Результат: A=1-60, B=61-120, C=121-180, D=181-240 — і ЧИСЛО, що
   * показуємо поруч із літерою, це САМЕ G (наприклад "C140"), а не
   * позиція всередині сектору (не "не по 60 на сектор", як і просили).
   */
  function pinToSector(pinIndex) {
    const g = ((119 - pinIndex + NUM_PINS) % NUM_PINS) + 1; // 1..240
    const sectorIdx = Math.floor((g - 1) / SECTOR_SIZE);
    return { letter: SECTOR_LETTERS[sectorIdx], number: g };
  }

  function pinToLabel(pinIndex) {
    const { letter, number } = pinToSector(pinIndex);
    return `${letter}${number}`;
  }

  /**
   * Довжина хорди (см) між двома пінами, рівномірно розташованими по колу
   * діаметром diameterCm серед numPins пінів. Формула симетрична відносно
   * "довгого" чи "короткого" шляху навколо кола — не потребує додаткової
   * нормалізації різниці індексів.
   */
  function chordLengthCm(pinA, pinB, numPins, diameterCm) {
    const radius = diameterCm / 2;
    const deltaTheta = (2 * Math.PI * Math.abs(pinA - pinB)) / numPins;
    return 2 * radius * Math.abs(Math.sin(deltaTheta / 2));
  }

  /**
   * Сумарна довжина нитки (см) для послідовності пінів від початку до
   * індексу stepIndex включно (stepIndex — індекс у масиві pins, тобто
   * "стільки з'єднань уже зроблено").
   */
  function threadUsedCm(pins, stepIndex, numPins, diameterCm) {
    let total = 0;
    const end = Math.min(stepIndex, pins.length - 1);
    for (let i = 0; i < end; i++) {
      total += chordLengthCm(pins[i], pins[i + 1], numPins, diameterCm);
    }
    return total;
  }

  function totalThreadCm(pins, numPins, diameterCm) {
    return threadUsedCm(pins, pins.length - 1, numPins, diameterCm);
  }

  function cmToMeters(cm) {
    return cm / 100;
  }

  const SectorUtils = {
    pinToSector,
    pinToLabel,
    chordLengthCm,
    threadUsedCm,
    totalThreadCm,
    cmToMeters,
  };

  // Подвійна сумісність: у браузері виставляємо window.SectorUtils (як і
  // раніше), а в Node (сервер, генерація файлу розпіновки для Telegram)
  // цей самий файл можна підключити через require() — ОДНА формула, без
  // ризику розійтися між тим, що бачить клієнт, і тим, що йде в текстовий
  // файл на випадок збою сервера.
  if (typeof window !== 'undefined') {
    window.SectorUtils = SectorUtils;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SectorUtils;
  }
})();
