/*
 * Проверка сборки текста для озвучки.
 *
 * Повод: 06.09.2026 вслух читались карточки команд —
 * «Bash cd /Users/... && Bash date ... Проверяю со своей стороны: ...».
 * Человеку нужен рассказ о сделанном, а не рабочая кухня агента.
 *
 * Запуск: node test/speak-extract.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── крошечная замена браузерного дерева: только то, что использует сборщик ──

class FakeText {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; }
  get textContent() { return this.nodeValue; }
}

class FakeEl {
  constructor(tag, cls, children = [], visible = true) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.className = cls || '';
    this.childNodes = children;
    this._visible = visible;
  }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  getClientRects() { return this._visible ? [{}] : []; }
  matches(selector) {
    // поддерживаем ровно те виды, что есть в списке пропуска
    return selector.split(',').map(s => s.trim()).some(part => {
      const attr = part.match(/^\[class\*="([^"]+)"\]$/);
      if (attr) return this.className.includes(attr[1]);
      if (part === '[hidden]') return this.hidden === true;
      if (part === '[aria-hidden="true"]') return this.ariaHidden === true;
      if (part.startsWith('.')) return this.className.split(/\s+/).includes(part.slice(1));
      return part.toLowerCase() === this.tagName.toLowerCase();
    });
  }
  querySelector(selector) {
    const cls = selector.replace(/^\./, '');
    const walk = (node) => {
      if (node.nodeType !== 1) return null;
      if (node.className && node.className.split(/\s+/).includes(cls)) return node;
      for (const c of node.childNodes) { const hit = walk(c); if (hit) return hit; }
      return null;
    };
    for (const c of this.childNodes) { const hit = walk(c); if (hit) return hit; }
    return null;
  }
}

const el = (tag, cls, children, visible) => new FakeEl(tag, cls, children, visible);
const txt = (s) => new FakeText(s);

// ── достаём сборщик из плагина, не запуская сам плагин ──

global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const grab = (name, kind) => {
  const re = new RegExp('(?:const ' + name + ' = [\\s\\S]*?;\\n)|(?:function ' + name + '\\([\\s\\S]*?\\n\\})', 'm');
  const m = src.match(re);
  if (!m) throw new Error('в main.js не найдено: ' + name);
  return m[0];
};
const code = grab('SPEAK_REPLACEMENTS') + '\n' + grab('SPEAK_SKIP_SELECTOR') + '\n'
  + grab('extractSpeakable') + '\nextractSpeakable';
// eval здесь намеренно: плагин — единый файл для Obsidian, без экспорта модулей.
// Исполняется только наш собственный main.js из соседней папки, никаких внешних
// данных сюда не попадает. Альтернатива — сборщик ради одного теста.
const extractSpeakable = eval(code);

// ── сам случай из жизни ──

const settings = { skipCodeBlocks: true, maxSpeakChars: 2500 };

const message = el('div', 'claudian-message claudian-message-assistant', [
  el('div', 'claudian-message-content', [
    // карточка выполненной команды — читать её вслух не нужно
    el('div', 'claudian-tool-call claudian-tool-call-bash', [
      el('span', 'claudian-tool-name', [txt('Bash')]),
      el('code', 'claudian-tool-bash-command', [txt('cd "/Users/vadimfedorov/Obsidian/Vault" && ls -la')]),
    ]),
    // размышления агента — тоже не для ушей
    el('div', 'claudian-thinking-block', [txt('Надо проверить настройки плагина')]),
    // а вот это человек и должен услышать
    el('p', '', [txt('Проверяю со своей стороны: файлы установлены, настройки на месте.')]),
    el('p', '', [txt('Голос стоит на Алёне.')]),
    // спрятанный узел с исходником сообщения
    el('div', 'claudian-hidden', [txt('**жирный** \\\\ [[ссылка]]')], false),
  ]),
]);

const spoken = extractSpeakable(message, settings);

const checks = [
  ['не читает слово Bash', !/Bash/i.test(spoken)],
  ['не читает путь к папке', !spoken.includes('/Users/')],
  ['не читает саму команду', !spoken.includes('ls -la') && !spoken.includes('&&')],
  ['не читает размышления', !spoken.includes('Надо проверить')],
  ['не читает спрятанный исходник', !spoken.includes('жирный')],
  ['читает первый абзац', spoken.includes('Проверяю со своей стороны')],
  ['читает второй абзац', spoken.includes('Голос стоит на Алёне')],
];

// ── тот же ответ, но панель чата скрыта (открыта вторая вкладка) ──
// 06.09.2026: из-за проверки геометрии в этом случае вслух не читалось НИЧЕГО.

const hidden = el('div', 'claudian-message claudian-message-assistant', [
  el('div', 'claudian-message-content', [
    el('div', 'claudian-tool-call', [txt('Bash ls -la')], false),
    el('div', 'claudian-text-block', [txt('Готово, я обновил заметку.')], false),
  ], false),
], false);

const spokenHidden = extractSpeakable(hidden, settings);
checks.push(['читает ответ, даже когда панель скрыта', spokenHidden.includes('Готово, я обновил заметку')]);
checks.push(['в скрытой панели тоже не читает команды', !/Bash|ls -la/.test(spokenHidden)]);



// ── список должен превратиться в предложения, а не в одну строку ──
// 06.09.2026: Vadim — «звучит роботизированно, неправильно расставляет ударения».
// Причина была в том, что пункты списка склеивались без точек.

const list = el('div', 'claudian-message claudian-message-assistant', [
  el('div', 'claudian-message-content', [
    el('p', '', [txt('Два филиала в городе:')]),
    el('ul', '', [
      el('li', '', [txt('пр. Чулман, 19 (главная)')]),
      el('li', '', [txt('Набережночелнинский пр., 62 (новый)')]),
    ]),
    el('p', '', [txt('Врачи: 16 специалистов, суммарный стаж 272 года')]),
    el('p', '', [txt('Скидка 15% для Vadim’а')]),
  ]),
]);

const spokenList = extractSpeakable(list, settings);
checks.push(['пункты списка разделены точками', (spokenList.match(/\./g) || []).length >= 3]);
checks.push(['список не склеен в одну строку', !/\(главная\)\s+Набережночелнинский/.test(spokenList)]);
checks.push(['сокращение «пр.» произносится словом', spokenList.includes('проспект')]);
checks.push(['процент произносится словом', spokenList.includes('процентов') && !spokenList.includes('%')]);
checks.push(['латинское имя читается по-русски', spokenList.includes('Вадим') && !/Vadim/.test(spokenList)]);
console.log('\nсписок вслух: ' + JSON.stringify(spokenList) + '\n');

let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '✓' : '✗') + ' ' + name);
  if (!ok) failed++;
}
console.log('\nчто прозвучит: ' + JSON.stringify(spoken));

if (failed) {
  console.error('\nПРОВЕРКА ПРОВАЛЕНА: ' + failed + ' из ' + checks.length);
  process.exit(1);
}
console.log('\nВсе проверки пройдены.');
