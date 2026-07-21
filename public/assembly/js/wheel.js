// public/assembly/js/wheel.js
//
// Малює SVG-колесо пінів один раз (піни, сектори, підписи), і надає
// setStep(fromPin, toPin) для переміщення підсвітки без перемальовування
// всього колеса. Кут для піна обчислюється ТОЧНО за тією ж формулою, що й
// у C++ рушії (StringArtImage.cpp) — щоб орієнтація на екрані співпадала
// з фізичною рамою.

(function () {
  'use strict';

  const CX = 150;
  const CY = 150;
  const PIN_RADIUS = 128;
  const TICK_IN = 122;
  const TICK_OUT_MINOR = 132;
  const TICK_OUT_MAJOR = 136; // кожен 10-й пін — трохи довша риска, легше рахувати
  const LABEL_RADIUS = 150;
  const SECTOR_INNER = 96;

  // Той самий порядок, що й фактичні букви в sectors.js для цих же
  // raw-діапазонів (перевірено тестами на збіг) — інакше підпис на
  // колесі розійдеться з тим, що показує гігантська інструкція нижче.
  // Індекс 0 (піни 0-59, верх-право) = B; індекс 1 (піни 60-119,
  // верх-ліво) = A; індекс 2 (піни 120-179, низ-ліво) = D; індекс 3
  // (піни 180-239, низ-право) = C. C/D свідомо переставлені відносно
  // "природного" порядку — так за годинниковою стрілкою літери йдуть
  // логічно A,B,C,D по колу.
  const SECTOR_LETTERS = ['B', 'A', 'D', 'C'];
  const SECTOR_COLORS = ['#141317', '#18171b']; // ледь відмінні відтінки — просто щоб сектори читались

  function angleForPin(pinIndex, numPins) {
    return (2 * Math.PI * pinIndex) / numPins;
  }

  function pointForPin(pinIndex, numPins, radius) {
    const angle = angleForPin(pinIndex, numPins);
    return {
      x: CX + radius * Math.cos(angle),
      y: CY - radius * Math.sin(angle),
    };
  }

  function polarArcPath(rInner, rOuter, angleStart, angleEnd) {
    // angleStart/angleEnd у радіанах, математична конвенція (проти годинникової),
    // але з y-down екрана (як і в pointForPin) — узгоджено між собою.
    const p = (r, a) => ({ x: CX + r * Math.cos(a), y: CY - r * Math.sin(a) });
    const a0 = p(rOuter, angleStart);
    const a1 = p(rOuter, angleEnd);
    const b1 = p(rInner, angleEnd);
    const b0 = p(rInner, angleStart);
    const largeArc = Math.abs(angleEnd - angleStart) > Math.PI ? 1 : 0;
    // Дуга йде у напрямку зменшення кута на екрані (бо y=-sin) — sweep=1 з огляду на y-down.
    return [
      `M ${a0.x} ${a0.y}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${a1.x} ${a1.y}`,
      `L ${b1.x} ${b1.y}`,
      `A ${rInner} ${rInner} 0 ${largeArc} 0 ${b0.x} ${b0.y}`,
      'Z',
    ].join(' ');
  }

  function init(numPins) {
    const pinsGroup = document.getElementById('wheel-pins');
    const sectorArcsGroup = document.getElementById('wheel-sector-arcs');
    const labelsGroup = document.getElementById('wheel-sector-labels');

    // --- Сектори (фонові сегменти + підписи) ---
    const sectorSize = numPins / 4;
    let arcsSvg = '';
    let labelsSvg = '';
    for (let s = 0; s < 4; s++) {
      const startPin = s * sectorSize;
      const endPin = (s + 1) * sectorSize;
      const angleStart = angleForPin(startPin, numPins);
      const angleEnd = angleForPin(endPin, numPins);
      arcsSvg += `<path d="${polarArcPath(SECTOR_INNER, PIN_RADIUS + 6, angleStart, angleEnd)}" fill="${SECTOR_COLORS[s % 2]}" />`;

      const midPin = startPin + sectorSize / 2;
      const labelPoint = pointForPin(midPin, numPins, LABEL_RADIUS);
      labelsSvg += `<text x="${labelPoint.x.toFixed(1)}" y="${labelPoint.y.toFixed(1)}" class="wheel-sector-label" text-anchor="middle" dominant-baseline="middle">${SECTOR_LETTERS[s]}</text>`;
    }
    sectorArcsGroup.innerHTML = arcsSvg;
    labelsGroup.innerHTML = labelsSvg;

    // --- Тіки пінів ---
    let pinsSvg = '';
    for (let i = 0; i < numPins; i++) {
      const isMajor = i % 10 === 0;
      const inner = pointForPin(i, numPins, TICK_IN);
      const outer = pointForPin(i, numPins, isMajor ? TICK_OUT_MAJOR : TICK_OUT_MINOR);
      pinsSvg += `<line x1="${inner.x.toFixed(1)}" y1="${inner.y.toFixed(1)}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" class="${isMajor ? 'wheel-tick wheel-tick-major' : 'wheel-tick'}" data-pin="${i}" />`;
    }
    pinsGroup.innerHTML = pinsSvg;
  }

  /**
   * Переміщує маркери "від" і "до" на позиції відповідних пінів.
   * fromPin може бути null (перший крок — лише стартовий пін, без "від").
   */
  function setStep(fromPin, toPin, numPins) {
    const fromMarker = document.getElementById('wheel-from-marker');
    const toMarker = document.getElementById('wheel-to-marker');
    const chordPreview = document.getElementById('wheel-chord-preview');

    const pTo = pointForPin(toPin, numPins, PIN_RADIUS);
    toMarker.setAttribute('cx', pTo.x.toFixed(1));
    toMarker.setAttribute('cy', pTo.y.toFixed(1));

    if (fromPin === null || fromPin === undefined) {
      fromMarker.style.display = 'none';
      chordPreview.style.display = 'none';
      return;
    }

    const pFrom = pointForPin(fromPin, numPins, PIN_RADIUS);
    fromMarker.setAttribute('cx', pFrom.x.toFixed(1));
    fromMarker.setAttribute('cy', pFrom.y.toFixed(1));
    fromMarker.style.display = '';

    chordPreview.setAttribute('x1', pFrom.x.toFixed(1));
    chordPreview.setAttribute('y1', pFrom.y.toFixed(1));
    chordPreview.setAttribute('x2', pTo.x.toFixed(1));
    chordPreview.setAttribute('y2', pTo.y.toFixed(1));
    chordPreview.style.display = '';
  }

  window.Wheel = { init, setStep, pointForPin, angleForPin };
})();
