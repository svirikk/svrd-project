// server/services/pinout.js
//
// Генерує текстовий файл розпіновки (крок за кроком, секторна нотація) —
// підстраховка на випадок збою сервера: якщо застосунок складання колись
// стане недоступний чи дані загубляться, власник бізнесу може вручну
// переслати клієнту цей файл, і той завершить картину без сайту.
//
// Використовує ТУ САМУ функцію pinToLabel, що й фронтенд (sectors.js
// підключений через require — дивись коментар у самому sectors.js про
// подвійну сумісність браузер/Node). Нумерація кроків у файлі 1-в-1
// збігається з тим, що показує екран застосунку ("Крок 1847 з 3800"),
// щоб під час ручної підказки по телефону не виникало плутанини.

const SectorUtils = require('../../public/assembly/js/sectors.js');

function buildPinoutText({ code, customer, stats, pins }) {
  const maxStep = pins.length - 1;
  const lines = [];

  lines.push(`РОЗПІНОВКА ЗАМОВЛЕННЯ ${code}`);
  lines.push(`Клієнт: ${customer.fullName}`);
  lines.push(`Дата створення: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })}`);
  lines.push(`Пінів на рамі: 240`);
  lines.push(`Усього кроків плетіння: ${maxStep}`);
  if (stats && stats.metersWithMargin) {
    lines.push(`Орієнтовний метраж нитки: ~${stats.metersWithMargin} м (із запасом)`);
  }
  lines.push('');
  lines.push('Сектори за годинниковою стрілкою: A (ліва частина кола) -> B -> C -> D.');
  lines.push('Формат кроку: "Крок N: ЗВІДКИ -> КУДИ" — той самий номер кроку, що на екрані застосунку.');
  lines.push('');
  lines.push('-'.repeat(40));
  lines.push('');
  lines.push(`Старт: ${SectorUtils.pinToLabel(pins[0])}`);

  for (let i = 1; i <= maxStep; i++) {
    const from = SectorUtils.pinToLabel(pins[i - 1]);
    const to = SectorUtils.pinToLabel(pins[i]);
    lines.push(`Крок ${i}: ${from} -> ${to}`);
  }

  lines.push('');
  lines.push(`Кінець (крок ${maxStep} з ${maxStep}) — картину завершено.`);

  return lines.join('\n');
}

module.exports = { buildPinoutText };
