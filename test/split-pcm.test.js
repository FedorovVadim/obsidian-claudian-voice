/*
 * Проверка нарезки длинной диктовки.
 *
 * Повод: 06.09.2026 Vadim — «диктовка прерывается через 20-30 секунд».
 * Яндекс принимает не больше 30 секунд за запрос, поэтому длинную запись
 * режем сами. Резать надо в тишине между словами, иначе слово рвётся
 * пополам и обе половины распознаются мусором.
 *
 * Запуск: node test/split-pcm.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const m = src.match(/function splitPcmAtQuiet[\s\S]*?\n}/);
if (!m) throw new Error('в main.js не найдена splitPcmAtQuiet');
// eval — плагин лежит одним файлом без экспорта модулей; исполняем только свой код
const splitPcmAtQuiet = eval('(' + m[0].replace('function splitPcmAtQuiet', 'function') + ')');

const RATE = 16000;
const CHUNK = 25 * RATE;

// шестьдесят секунд «речи»: громко, но с короткими паузами каждые пять секунд
const total = 60 * RATE;
const pcm = new Int16Array(total);
const quietZones = [];
for (let i = 0; i < total; i++) {
  const sec = i / RATE;
  const inPause = (sec % 5) > 4.7;            // 300 мс тишины каждые 5 секунд
  pcm[i] = inPause ? 0 : Math.round(8000 * Math.sin(i / 12));
}
for (let sec = 5; sec < 60; sec += 5) quietZones.push(sec * RATE - 0.15 * RATE);

const parts = splitPcmAtQuiet(pcm, CHUNK);
const lengths = parts.map(p => p.length);
const sum = lengths.reduce((a, b) => a + b, 0);

// где прошли разрезы
const cuts = [];
let acc = 0;
for (let i = 0; i < parts.length - 1; i++) { acc += parts[i].length; cuts.push(acc); }

const nearQuiet = cuts.every(c => quietZones.some(q => Math.abs(q - c) < 0.4 * RATE));

const checks = [
  ['ничего не потеряно', sum === total],
  ['каждый кусок укладывается в лимит', lengths.every(l => l <= CHUNK)],
  ['кусков ровно столько, сколько нужно', parts.length === 3],
  ['разрезы пришлись на паузы, а не на середину слова', nearQuiet],
  ['короткая запись не режется', splitPcmAtQuiet(pcm.subarray(0, 10 * RATE), CHUNK).length === 1],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '✓' : '✗') + ' ' + name);
  if (!ok) failed++;
}
console.log('\nдлины кусков, сек: ' + lengths.map(l => (l / RATE).toFixed(1)).join(', '));
console.log('разрезы на секундах: ' + cuts.map(c => (c / RATE).toFixed(2)).join(', '));

if (failed) { console.error('\nПРОВЕРКА ПРОВАЛЕНА: ' + failed + ' из ' + checks.length); process.exit(1); }
console.log('\nВсе проверки пройдены.');
