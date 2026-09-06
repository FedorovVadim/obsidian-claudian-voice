'use strict';

/*
 * Claudian Voice — голосовое управление плагином Claudian (realclaudian).
 *
 * Что делает:
 *  1. Диктовка: жмёшь кнопку 🎤 (или горячую клавишу) → говоришь → текст
 *     распознаётся (OpenAI Whisper или Яндекс SpeechKit) и отправляется в чат Claudian.
 *  2. Озвучка: когда Claudian заканчивает ответ, плагин читает его вслух
 *     (системный голос macOS бесплатно или OpenAI TTS).
 *  3. Режим диалога: после озвучки ответа микрофон включается снова —
 *     разговор идёт голосом туда-обратно без рук.
 *
 * Интеграция с Claudian — через интерфейс (DOM):
 *  - ввод:    textarea.claudian-input  (+ событие input + Enter для отправки)
 *  - ответы:  .claudian-messages → .claudian-message-assistant
 *  - занят:   .claudian-tab-badge-streaming (агент ещё печатает)
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, setIcon, Platform } = require('obsidian');

// ────────────────────────────────────────────────────────────────────────────
// Настройки по умолчанию
// ────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  // Распознавание речи (что говорю → текст)
  sttProvider: 'openai',            // 'openai' | 'yandex'
  openaiApiKey: '',
  openaiSttModel: 'whisper-1',      // 'whisper-1' | 'gpt-4o-mini-transcribe' | 'gpt-4o-transcribe'
  yandexApiKey: '',
  language: 'ru',

  // Поведение
  autoSend: true,                   // отправлять сразу после распознавания
  autoSpeak: true,                  // озвучивать ответы Claudian
  onlyAfterMine: true,              // озвучивать только ответы на мои сообщения (не старые беседы)
  conversationMode: false,          // после озвучки снова включать микрофон
  vadEnabled: true,                 // автостоп записи по тишине
  silenceStopSec: 2.0,              // сколько секунд тишины = конец фразы
  maxRecordSec: 90,                 // предохранитель длины записи

  // Озвучка (текст → голос)
  ttsEngine: 'system',              // 'system' (бесплатно) | 'yandex' | 'openai'
  systemVoice: '',                  // имя системного голоса ('' = авто-русский)
  ttsRate: 1.0,                     // скорость речи
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiTtsVoice: 'alloy',
  yandexTtsVoice: 'alena',          // голос Yandex SpeechKit (тот же ключ, что и для распознавания)
  yandexTtsApi: 'v3',               // 'v3' — новый движок (живее и дешевле) | 'v1' — старый
  yandexTtsRole: 'good',            // амплуа голоса в v3: good | neutral | friendly | strict
  debugDump: true,                  // писать последний озвученный текст в файл (для разбора ошибок)
  // Пересказ для ушей: письменный ответ (заголовки, списки, детали) плохо
  // звучит вслух, каким голосом его ни читай. Перед озвучкой просим модель
  // пересказать его живой речью — главное вперёд.
  rewriteForSpeech: false,          // включается после того, как вставлен ключ
  rewriteApiKey: '',                // ключ Yandex Cloud с ролью ai.languageModels.user
  rewriteFolderId: '',              // каталог Yandex Cloud
  rewriteModel: 'yandexgpt-5-lite', // дешёвая модель, для пересказа достаточно
  rewriteMinChars: 400,             // короткие ответы пересказывать незачем
  rewriteTargetChars: 900,          // примерно минута речи

  skipCodeBlocks: true,             // код и таблицы не читать вслух
  maxSpeakChars: 2500,              // длиннее — обрезать («дальше на экране»)
};

// ────────────────────────────────────────────────────────────────────────────
// Утилиты: аудио
// ────────────────────────────────────────────────────────────────────────────

/** Линейный ресемплинг Float32 → 16 кГц */
function resampleTo16k(float32, fromRate) {
  const toRate = 16000;
  if (fromRate === toRate) return float32;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, float32.length - 1);
    const frac = pos - i0;
    out[i] = float32[i0] * (1 - frac) + float32[i1] * frac;
  }
  return out;
}

/** Float32 [-1..1] → Int16 PCM */
function floatToPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Int16 PCM → WAV-файл (моно) */
function pcm16ToWav(pcm, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** Сборка multipart/form-data вручную (requestUrl не умеет FormData) */
function buildMultipart(parts, boundary) {
  const enc = new TextEncoder();
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.type) head += `Content-Type: ${p.type}\r\n`;
    head += '\r\n';
    chunks.push(enc.encode(head));
    chunks.push(p.data instanceof Uint8Array ? p.data : enc.encode(String(p.data)));
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

// ────────────────────────────────────────────────────────────────────────────
// Утилиты: текст для озвучки
// ────────────────────────────────────────────────────────────────────────────

/**
 * Слова, которые синтез читает неправильно: сокращения он произносит по буквам,
 * латиницу — с английским выговором посреди русской фразы.
 * Заменяем на то, как это звучит в живой речи.
 */
const SPEAK_REPLACEMENTS = [
  // ВАЖНО: \b в JavaScript не работает с кириллицей (буква «п» для него не буква),
  // поэтому границу слова задаём просмотром назад — иначе замены молча не срабатывают
  [/(?<![А-Яа-яЁё])пр-?т\.?(?=[\s,;:)]|$)/gi, 'проспект'],
  [/(?<![А-Яа-яЁё])пр\.(?=[\s,;:)]|$)/gi, 'проспект'],
  [/(?<![А-Яа-яЁё])ул\.(?=[\s,;:)]|$)/gi, 'улица'],
  [/(?<![А-Яа-яЁё])д\.\s*(?=\d)/gi, 'дом '],
  [/(?<![А-Яа-яЁё])г\.\s*(?=[А-ЯЁ])/g, 'город '],
  [/(?<![А-Яа-яЁё])тыс\.(?=[\s,;:)]|$)/gi, 'тысяч'],
  [/(?<![А-Яа-яЁё])млн(?![А-Яа-яЁё])/gi, 'миллионов'],
  [/(?<![А-Яа-яЁё])млрд(?![А-Яа-яЁё])/gi, 'миллиардов'],
  [/(?<![А-Яа-яЁё])руб\.(?=[\s,;:)]|$)/gi, 'рублей'],
  [/(?<![А-Яа-яЁё])т\.\s*е\./gi, 'то есть'],
  [/(?<![А-Яа-яЁё])и\s*т\.\s*д\./gi, 'и так далее'],
  [/(?<![А-Яа-яЁё])т\.\s*к\./gi, 'так как'],
  [/(?<![А-Яа-яЁё])см\.(?=\s)/gi, 'смотри'],
  [/₽/g, ' рублей'], [/%/g, ' процентов'], [/№\s*/g, 'номер '],
  // латиница, которая встречается у нас чаще всего.
  // Имя с русским окончанием через апостроф склеиваем: Vadim'а -> Вадима
  [/\bVadim['’]([а-яё]+)/g, 'Вадим$1'], [/\bVadim\b/g, 'Вадим'],
  [/\bClaudian\b/gi, 'Клодиан'], [/\bObsidian\b/gi, 'Обсидиан'],
  [/\bClaude\b/gi, 'Клод'], [/\bAnthropic\b/gi, 'Антропик'], [/\bGitHub\b/gi, 'Гитхаб'],
  [/\bYandex\b/gi, 'Яндекс'], [/\bSpeechKit\b/gi, 'СпичКит'], [/\bOpenAI\b/gi, 'ОупенЭйАй'],
  [/\bWhisper\b/gi, 'Виспер'], [/\bTelegram\b/gi, 'Телеграм'], [/\bMac\b/g, 'Мак'],
  [/\bWarpoint\b/gi, 'Варпойнт'], [/\bBRAT\b/g, 'Брат'],
];

/**
 * Что НЕ читаем вслух ни при каких условиях: кнопки, значки, служебные плашки,
 * скрытые узлы (в них у Claudian лежит исходный текст сообщения с разметкой —
 * именно оттуда в речь попадали «бэкслэш-бэкслэш» и хвост со временем ответа).
 */
const SPEAK_SKIP_SELECTOR = [
  'img', 'svg', 'button', 'input', 'textarea', 'style', 'script', 'audio', 'video',
  '[aria-hidden="true"]', '[hidden]', '.claudian-hidden',
  '[class*="badge"]', '[class*="action"]', '[class*="toolbar"]',
  '[class*="duration"]', '[class*="usage"]', '[class*="token"]', '[class*="cost"]',
  '[class*="timestamp"]', '[class*="meta"]', '[class*="footer"]', '[class*="copy"]',
  // рабочая кухня агента: команды, их вывод, правки файлов, размышления, планы.
  // Человеку нужен рассказ о сделанном, а не «Bash cd слэш Users слэш…»
  '[class*="claudian-tool"]', '[class*="claudian-thinking"]', '[class*="claudian-diff"]',
  '[class*="claudian-code"]', '[class*="claudian-ask-approval"]', '[class*="claudian-plan"]',
  '[class*="claudian-mcp"]', '[class*="claudian-agent-skill"]', '[class*="claudian-todo"]',
  '[class*="claudian-inline-preview"]', '[class*="claudian-external-context"]',
].join(',');

/**
 * Вытащить из блока ответа человекочитаемый текст.
 * Идём по живому дереву, а не по копии: так видно, что реально нарисовано на
 * экране, а что спрятано (у копии getClientRects всегда пуст).
 */
function extractSpeakable(messageEl, settings) {
  const content = messageEl.querySelector('.claudian-message-content') || messageEl;
  const parts = [];

  // Спрятанные узлы отбрасываем по геометрии — но только если сам блок ответа
  // нарисован. Когда скрыта вся панель (например, открыта вторая вкладка чата),
  // рамок нет вообще ни у чего, и такая проверка выкинула бы весь текст.
  const panelDrawn = !!(content.getClientRects && content.getClientRects().length);
  const visible = (el) => {
    if (!panelDrawn) return true;
    if (!el.getClientRects || el.getClientRects().length) return true;
    // элемент без геометрии считаем спрятанным (но пустые обёртки не режем зря)
    return !(el.textContent || '').trim();
  };

  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.nodeValue); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'pre') { parts.push(settings.skipCodeBlocks ? ' Код — на экране. ' : ' '); return; }
    if (tag === 'table') { parts.push(settings.skipCodeBlocks ? ' Таблица — на экране. ' : ' '); return; }
    if (node.matches && node.matches(SPEAK_SKIP_SELECTOR)) return;
    if (!visible(node)) return;
    // граница блока: пункт списка, абзац, заголовок. Помечаем переводом строки —
    // ниже каждая такая строка получит точку. Без этого список склеивается в
    // одну строку без пауз, и синтез читает её ровным роботом.
    const isBlock = /^(p|div|li|h[1-6]|blockquote|br|tr|section|article)$/.test(tag);
    if (isBlock) parts.push('\n');
    node.childNodes.forEach(walk);
    if (isBlock) parts.push('\n');
  };
  walk(content);

  // каждая смысловая строка — отдельное предложение с точкой в конце
  let t = parts.join('')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map(line => /[.!?…:;,]$/.test(line) ? line : line + '.')
    .join(' ');
  t = t.replace(/\\+/g, ' ');                       // экранирующие косые черты не читаем
  // страховка на случай, если кусок команды всё-таки просочился мимо разметки:
  // выбрасываем «слова» с признаками кода — их вслух читать бессмысленно
  t = t.replace(/(^|\s)\S*(&&|\|\||<<|>>|\$\(|;\s*python3|--[a-z][a-z-]{2,})\S*/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, ' ссылка ');
  // ссылки на заметки: читаем только название, без папок и расширения
  t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  t = t.replace(/\[\[([^\]]+)\]\]/g, (m, p) => p.split('/').pop().replace(/\.md$/i, ''));
  // путь к файлу вслух не читаем — «файл» понятнее, чем «слэш обсидиан слэш»
  t = t.replace(/[\w.-]*(?:\/[\w.-]+)+\.(?:md|js|json|py|ts|css|sh|txt|yml|yaml)\b/gi, ' файл ');
  t = t.replace(/\b[\w-]+\.(?:md|js|json|py|ts|css|sh|txt|yml|yaml)\b/gi, ' файл ');
  try { t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' '); } catch (e) { /* старый движок — пропустим */ }
  t = t.replace(/[*_`~|]+/g, ' ');
  t = t.replace(/(^|\s)#+(?=\s|$)/g, ' ');
  t = t.replace(/(^|\s)>+(?=\s)/g, ' ');
  t = t.replace(/^[-=]{3,}$/gm, ' ');
  for (const [from, to] of SPEAK_REPLACEMENTS) t = t.replace(from, to);
  t = t.replace(/\s+([,.!?;:])/g, '$1');
  t = t.replace(/([.!?])\1+/g, '$1');            // «..» после склейки строк
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > settings.maxSpeakChars) {
    t = t.slice(0, settings.maxSpeakChars);
    const cut = t.lastIndexOf('. ');
    if (cut > settings.maxSpeakChars * 0.6) t = t.slice(0, cut + 1);
    t += ' … Ответ длинный, дальше читай на экране.';
  }
  return t;
}

/** Разбить текст на куски ≤ maxLen (браузерная озвучка обрывается на длинных) */
function splitSentences(text, maxLen = 240) {
  const raw = text.split(/(?<=[.!?…])\s+/);
  const out = [];
  let cur = '';
  for (let s of raw) {
    while (s.length > maxLen) {
      let cut = s.lastIndexOf(',', maxLen);
      if (cut < maxLen * 0.4) cut = s.lastIndexOf(' ', maxLen);
      if (cut <= 0) cut = maxLen;
      out.push((cur + ' ' + s.slice(0, cut)).trim()); cur = '';
      s = s.slice(cut + 1);
    }
    if ((cur + ' ' + s).length > maxLen) { out.push(cur.trim()); cur = s; }
    else cur = (cur + ' ' + s).trim();
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Режет текст на куски не длиннее maxLen символов по границам предложений —
 * для сервисов озвучки с ограничением на длину запроса (у Яндекса это 5000).
 */
/**
 * Ответ нового движка Яндекса — цепочка JSON-объектов подряд, в каждом кусок
 * звука в base64. Просим «сырой» звук без заголовка, поэтому куски просто
 * склеиваются встык — заголовок мы потом напишем один на всю фразу.
 */
const V3_SAMPLE_RATE = 48000;

function decodeV3Pcm(raw) {
  if (!raw) return null;
  const chunks = [];
  const re = /"data"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const bin = atob(m[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    chunks.push(arr);
  }
  if (!chunks.length) return null;
  return concatBytes(chunks);
}

function concatBytes(list) {
  const total = list.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of list) { out.set(c, off); off += c.length; }
  return out;
}

/** Обернуть «сырой» звук в WAV, чтобы его мог проиграть обычный плеер */
function wavFromPcm(pcm, sampleRate = 48000, channels = 1, bits = 16) {
  const header = new Uint8Array(44);
  const dv = new DataView(header.buffer);
  const byteRate = sampleRate * channels * bits / 8;
  const str = (off, s) => { for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i); };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length, true);
  str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);              // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, channels * bits / 8, true);
  dv.setUint16(34, bits, true);
  str(36, 'data');
  dv.setUint32(40, pcm.length, true);
  return concatBytes([header, pcm]);
}

/** Выполнить задачи пачками по `limit` штук, сохранив порядок результатов */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function chunkForTts(text, maxLen = 3000) {
  const parts = splitSentences(text, Math.min(maxLen, 900));
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur.length + 1 + p.length) > maxLen) { out.push(cur); cur = p; }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────────────
// Диктофон: микрофон → PCM + автостоп по тишине
// ────────────────────────────────────────────────────────────────────────────

class Recorder {
  constructor(opts) {
    this.opts = opts; // { vad, silenceSec, maxSec, onTick(sec), onAutoStop() }
    this.chunks = [];
    this.sampleRate = 48000;
    this.startedAt = 0;
    this.lastVoiceAt = 0;
    this.voicedChunks = 0;
    this.stopped = false;
  }

  get durationSec() { return (Date.now() - this.startedAt) / 1000; }
  get hadSpeech() { return this.voicedChunks >= 3; }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.sampleRate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    // глушим выход в ноль, чтобы не слышать сам себя
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.startedAt = Date.now();
    this.lastVoiceAt = Date.now();

    this.proc.onaudioprocess = (e) => {
      if (this.stopped) return;
      const data = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(data));
      // громкость чанка (RMS)
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (data.length / 4));
      const now = Date.now();
      if (rms > 0.01) { this.voicedChunks++; this.lastVoiceAt = now; }
      if (this.opts.onTick) this.opts.onTick(this.durationSec, rms);
      const silence = (now - this.lastVoiceAt) / 1000;
      if (this.opts.vad && this.hadSpeech && silence >= this.opts.silenceSec) {
        this.opts.onAutoStop && this.opts.onAutoStop();
      } else if (this.durationSec >= this.opts.maxSec) {
        this.opts.onAutoStop && this.opts.onAutoStop();
      }
    };
    src.connect(this.proc);
    this.proc.connect(this.gain);
    this.gain.connect(this.ctx.destination);
  }

  /** Остановить и вернуть запись */
  stop() {
    if (this.stopped) return null;
    this.stopped = true;
    try { this.proc && this.proc.disconnect(); } catch (e) {}
    try { this.gain && this.gain.disconnect(); } catch (e) {}
    try { this.ctx && this.ctx.close(); } catch (e) {}
    try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    const total = this.chunks.reduce((s, c) => s + c.length, 0);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { all.set(c, off); off += c.length; }
    this.chunks = [];
    return { samples: all, rate: this.sampleRate, durationSec: total / this.sampleRate, hadSpeech: this.hadSpeech };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Основной плагин
// ────────────────────────────────────────────────────────────────────────────

class ClaudianVoicePlugin extends Plugin {

  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());

    this.state = 'idle';            // idle | rec | stt | speaking
    this.recorder = null;
    this.observer = null;
    this.watchedEl = null;
    this.quietTimer = null;
    this.known = new WeakSet();     // уже озвученные / старые блоки ответов
    this.expectingReply = false;    // ждём ответ на НАШЕ сообщение
    this.lastInputWasVoice = false; // последний ввод был голосом (для режима диалога)
    this.speechCancelled = false;
    this.currentAudio = null;
    this.sayProc = null;
    this.injectedButtons = new Set();

    // индикатор в статус-баре (внизу окна)
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('cv-status');
    this.statusEl.addEventListener('click', () => this.onStatusClick());
    this.renderStatus();

    // кнопка на левой панели
    this.addRibbonIcon('mic', 'Claudian Voice: диктовка голосом', () => this.toggleRecording());
    this.speakRibbonEl = this.addRibbonIcon(
      this.settings.autoSpeak ? 'volume-2' : 'volume-x',
      'Claudian Voice: читать ответы вслух',
      () => this.toggleAutoSpeak(),
    );
    this.speakRibbonEl.addClass('cv-speak-ribbon');
    this.refreshSpeakButtons();

    // команды (можно повесить горячие клавиши)
    this.addCommand({ id: 'toggle-dictation', name: 'Начать / завершить диктовку', callback: () => this.toggleRecording() });
    this.addCommand({ id: 'cancel-dictation', name: 'Отменить запись (не отправлять)', callback: () => this.cancelRecording(true) });
    this.addCommand({ id: 'stop-speaking', name: 'Остановить озвучку', callback: () => this.stopSpeaking() });
    this.addCommand({ id: 'speak-last', name: 'Озвучить последний ответ Claudian', callback: () => this.speakLastReply() });
    this.addCommand({
      id: 'toggle-autospeak', name: 'Авто-озвучка ответов: вкл / выкл',
      callback: () => this.toggleAutoSpeak(),
    });
    this.addCommand({
      id: 'toggle-conversation', name: 'Режим диалога (голосом туда-обратно): вкл / выкл',
      callback: async () => {
        this.settings.conversationMode = !this.settings.conversationMode;
        await this.saveData(this.settings);
        new Notice(this.settings.conversationMode ? '🗣 Режим диалога включён' : 'Режим диалога выключен');
      },
    });

    this.addSettingTab(new ClaudianVoiceSettingTab(this.app, this));

    // помечаем «ждём ответ», когда Vadim отправляет сообщение руками (Enter в поле Claudian)
    this.registerDomEvent(document, 'keydown', (e) => {
      if (!e.isTrusted) return;
      if (e.key !== 'Enter' || e.shiftKey) return;
      const t = e.target;
      if (t && t.classList && t.classList.contains('claudian-input')) {
        this.expectingReply = true;
        this.lastInputWasVoice = false;
      }
    }, { capture: true });

    // следим за интерфейсом Claudian
    this.registerEvent(this.app.workspace.on('layout-change', () => this.hookUi()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.hookUi()));
    this.registerInterval(window.setInterval(() => this.hookUi(), 3000));
    this.app.workspace.onLayoutReady(() => this.hookUi());
  }

  onunload() {
    this.cancelRecording(false);
    this.stopSpeaking();
    if (this.observer) this.observer.disconnect();
    if (this.quietTimer) window.clearTimeout(this.quietTimer);
    this.injectedButtons.forEach(b => b.remove());
    this.injectedButtons.clear();
  }

  // ── Поиск элементов Claudian ──────────────────────────────────────────────

  isVisible(el) { return !!(el && el.getClientRects && el.getClientRects().length); }

  getVisibleInput() {
    const list = document.querySelectorAll('.workspace-leaf-content[data-type="claudian-view"] textarea.claudian-input');
    for (const el of list) if (this.isVisible(el)) return el;
    return null;
  }

  getVisibleMessagesEl() {
    const list = document.querySelectorAll('.workspace-leaf-content[data-type="claudian-view"] .claudian-messages');
    for (const el of list) if (this.isVisible(el)) return el;
    return null;
  }

  claudianIsStreaming() {
    const root = this.watchedEl && this.watchedEl.closest('.workspace-leaf-content');
    const scope = root || document;
    return !!scope.querySelector('.claudian-tab-badge-streaming');
  }

  // ── Подключение к интерфейсу (наблюдатель + кнопки) ───────────────────────

  hookUi() {
    this.injectMicButtons();
    const el = this.getVisibleMessagesEl();
    if (!el) return;
    if (el === this.watchedEl && this.observer) return;
    if (this.observer) this.observer.disconnect();
    this.watchedEl = el;
    // всё, что уже на экране, считаем прочитанным (старые беседы не озвучиваем).
    // Исключение — ответ, который печатается прямо сейчас: он ещё не дописан,
    // и пометить его прочитанным значит навсегда его проглотить.
    const streaming = this.claudianIsStreaming();
    const all = el.querySelectorAll('.claudian-message-assistant');
    all.forEach((m, i) => {
      const isLast = i === all.length - 1;
      if (streaming && isLast) return;
      this.known.add(m);
    });
    this.observer = new MutationObserver((mutations) => {
      this.noticeMyMessage(mutations);
      this.bumpQuietTimer();
    });
    this.observer.observe(el, { childList: true, subtree: true, characterData: true });
  }

  injectMicButtons() {
    document.querySelectorAll('.claudian-input-toolbar').forEach(tb => {
      if (!tb.querySelector('.cv-mic-btn')) {
        const btn = document.createElement('button');
        btn.className = 'cv-mic-btn clickable-icon';
        btn.setAttribute('aria-label', 'Диктовка голосом (Claudian Voice)');
        btn.setAttribute('title', 'Диктовка голосом');
        setIcon(btn, 'mic');
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggleRecording(); });
        tb.appendChild(btn);
        this.injectedButtons.add(btn);
        if (this.state === 'rec') btn.addClass('is-rec');
      }
      // переключатель «читать ответы вслух» — рядом с микрофоном
      if (!tb.querySelector('.cv-speak-btn')) {
        const btn = document.createElement('button');
        btn.className = 'cv-speak-btn clickable-icon';
        btn.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          this.toggleAutoSpeak();
        });
        tb.appendChild(btn);
        this.injectedButtons.add(btn);
      }
    });
    this.refreshSpeakButtons();
  }

  /** Показать на кнопке текущее состояние: читаем вслух или молчим */
  refreshSpeakButtons() {
    const on = !!this.settings.autoSpeak;
    if (this.speakRibbonEl) {
      setIcon(this.speakRibbonEl, on ? 'volume-2' : 'volume-x');
      this.speakRibbonEl.toggleClass('is-off', !on);
      this.speakRibbonEl.setAttribute('aria-label',
        on ? 'Claudian Voice: ответы читаются вслух' : 'Claudian Voice: ответы только на экране');
    }
    document.querySelectorAll('.cv-speak-btn').forEach(b => {
      setIcon(b, on ? 'volume-2' : 'volume-x');
      b.toggleClass('is-off', !on);
      const hint = on ? 'Ответы читаются вслух — нажми, чтобы только читать с экрана'
                      : 'Ответы только на экране — нажми, чтобы слушать голосом';
      b.setAttribute('aria-label', hint);
      b.setAttribute('title', hint);
    });
  }

  async toggleAutoSpeak() {
    this.settings.autoSpeak = !this.settings.autoSpeak;
    await this.saveData(this.settings);
    if (!this.settings.autoSpeak) this.stopSpeaking();   // выключил — замолкаем сразу
    this.refreshSpeakButtons();
    new Notice(this.settings.autoSpeak ? '🔊 Читаю ответы вслух' : '🔇 Ответы только на экране');
  }

  /**
   * «Ответ на моё сообщение» определяем по появлению моего сообщения на экране,
   * а не только по нажатию Enter: отправить можно кнопкой, с телефона или
   * голосом — во всех случаях в списке появляется мой блок.
   */
  noticeMyMessage(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes || []) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) continue;
        const mine = (node.matches && node.matches('.claudian-message-user'))
          || (node.querySelector && node.querySelector('.claudian-message-user'));
        if (mine) {
          this.expectingReply = true;
          this.trace('увидел моё новое сообщение — жду ответ');
          return;
        }
      }
    }
  }

  bumpQuietTimer() {
    if (this.quietTimer) window.clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => this.onRepliesQuiet(), 1700);
  }

  /** Мутации затихли → возможно, Claudian дописал ответ */
  onRepliesQuiet() {
    if (!this.watchedEl) return;
    if (this.claudianIsStreaming()) { this.bumpQuietTimer(); return; }
    const msgs = this.watchedEl.querySelectorAll('.claudian-message-assistant');
    const last = msgs[msgs.length - 1];
    if (!last) return this.trace('ответов на экране не нашлось');
    if (this.known.has(last)) return this.trace('этот ответ уже отмечен прочитанным');
    this.known.add(last);
    if (!this.settings.autoSpeak) return this.trace('чтение вслух выключено кнопкой');
    if (this.settings.onlyAfterMine && !this.expectingReply) {
      return this.trace('ответ не на моё сообщение (не увидел отправку) — молчу');
    }
    this.expectingReply = false;
    const text = extractSpeakable(last, this.settings);
    if (!text) {
      // пустой результат почти всегда значит, что фильтр перестарался —
      // записываем улики, чтобы разбирать по факту, а не гадать
      const raw = (last.textContent || '').trim();
      const drawn = !!(last.getClientRects && last.getClientRects().length);
      return this.trace('после очистки читать нечего. В блоке было символов: ' + raw.length
        + ', блок нарисован на экране: ' + (drawn ? 'да' : 'нет')
        + ', начало: ' + JSON.stringify(raw.slice(0, 120)));
    }
    this.trace('озвучиваю, символов: ' + text.length);
    this.speakMaybeRetold(text);
  }

  /**
   * Перед озвучкой при желании пересказываем ответ живой речью.
   * Письменный текст со списками и заголовками звучит роботом независимо от
   * голоса — тут лечится не произношение, а сама подача.
   */
  async speakMaybeRetold(text) {
    let toSay = text;
    const s = this.settings;
    if (s.rewriteForSpeech && (s.rewriteApiKey || '').trim() && text.length >= s.rewriteMinChars) {
      try {
        const retold = await this.retellForSpeech(text);
        if (retold && retold.length > 40) {
          this.trace('пересказал для речи: было ' + text.length + ', стало ' + retold.length);
          toSay = retold;
        }
      } catch (e) {
        console.warn('[claudian-voice] пересказ не удался, читаю как есть:', e);
        this.trace('пересказ не удался (' + (e && e.message) + ') — читаю исходный текст');
      }
    }
    return this.speak(toSay);
  }

  /** Пересказ через YandexGPT — тот же облачный аккаунт, из России без VPN */
  async retellForSpeech(text) {
    const s = this.settings;
    const folder = (s.rewriteFolderId || '').trim();
    if (!folder) throw new Error('не указан каталог Yandex Cloud');

    const system = [
      'Ты пересказываешь письменный ответ помощника так, чтобы владелец слушал его вслух.',
      'Обращайся на «ты», говори от первого лица — это твой собственный отчёт о работе.',
      'Главное вперёд: что сделано и что нужно от собеседника. Дальше подробности по важности.',
      'Никаких списков, заголовков, разметки, путей к файлам, названий папок и версий.',
      'Живые связные предложения, каждое законченное. Сокращения и знаки — словами.',
      'Объём — около ' + (Number(s.rewriteTargetChars) || 900) + ' символов, это примерно минута речи.',
    ].join(' ');

    const resp = await requestUrl({
      url: 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      method: 'POST',
      headers: {
        'Authorization': 'Api-Key ' + s.rewriteApiKey.trim(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        modelUri: 'gpt://' + folder + '/' + (s.rewriteModel || 'yandexgpt-5-lite'),
        completionOptions: {
          temperature: 0.3,
          maxTokens: Math.max(200, Math.round((Number(s.rewriteTargetChars) || 900) / 2)),
        },
        messages: [
          { role: 'system', text: system },
          { role: 'user', text: text },
        ],
      }),
      throw: false,
    });
    if (resp.status >= 400) throw new Error('пересказ, ответ сервиса ' + resp.status);
    const alt = ((((resp.json || {}).result || {}).alternatives || [])[0] || {}).message || {};
    return (alt.text || '').trim();
  }

  /**
   * Короткий журнал решений рядом с плагином.
   * Нужен, чтобы разбирать «почему не заговорил» по факту, а не догадками:
   * слышимого не видно, а строчку в файле — видно.
   */
  trace(reason) {
    try {
      const fs = require('fs');
      const path = require('path');
      const file = path.join(
        this.app.vault.adapter.getBasePath(), '.obsidian', 'plugins', 'claudian-voice', 'voice.log');
      const stamp = new Date().toLocaleTimeString('ru-RU');
      let old = '';
      try { old = fs.readFileSync(file, 'utf8'); } catch (e) { /* первого файла ещё нет */ }
      const lines = (old + stamp + ' — ' + reason + '\n').split('\n').slice(-120);
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
    } catch (e) { /* журнал не должен ломать озвучку */ }
  }

  speakLastReply() {
    const el = this.getVisibleMessagesEl();
    if (!el) { new Notice('Окно Claudian не найдено'); return; }
    const msgs = el.querySelectorAll('.claudian-message-assistant');
    const last = msgs[msgs.length - 1];
    if (!last) { new Notice('В этой беседе пока нет ответов'); return; }
    const text = extractSpeakable(last, this.settings);
    if (text) this.speak(text); else new Notice('Нечего озвучивать');
  }

  // ── Запись ────────────────────────────────────────────────────────────────

  toggleRecording() {
    if (this.state === 'rec') this.finishRecording();
    else if (this.state === 'stt') { /* идёт распознавание — ждём */ }
    else this.startRecording();
  }

  async startRecording() {
    if (this.state === 'rec') return;
    this.stopSpeaking(); // чтобы микрофон не записал озвучку
    const maxSec = this.settings.sttProvider === 'yandex'
      ? Math.min(29, this.settings.maxRecordSec)
      : this.settings.maxRecordSec;
    const rec = new Recorder({
      vad: this.settings.vadEnabled,
      silenceSec: Math.max(0.8, Number(this.settings.silenceStopSec) || 2),
      maxSec,
      onTick: (sec) => this.renderStatus(sec),
      onAutoStop: () => this.finishRecording(),
    });
    try {
      await rec.start();
    } catch (e) {
      console.error('[claudian-voice] микрофон:', e);
      new Notice('🎤 Микрофон недоступен. Разреши доступ: Настройки macOS → Конфиденциальность → Микрофон → Obsidian', 8000);
      return;
    }
    this.recorder = rec;
    this.setState('rec');
    new Notice(this.settings.vadEnabled
      ? '🎤 Говорите… (пауза ≈' + Math.round(rec.opts.silenceSec) + ' сек = отправка)'
      : '🎤 Говорите… (кнопка 🎤 ещё раз = отправка)', 2500);
  }

  async finishRecording() {
    if (this.state !== 'rec' || !this.recorder) return;
    const res = this.recorder.stop();
    this.recorder = null;
    this.setState('stt');
    try {
      if (!res || res.durationSec < 0.4 || (this.settings.vadEnabled && !res.hadSpeech)) {
        new Notice('Тишина — ничего не отправляю');
        return;
      }
      const f16 = resampleTo16k(res.samples, res.rate);
      const pcm = floatToPcm16(f16);
      let text = '';
      try {
        text = await this.transcribe(pcm);
      } catch (e) {
        console.error('[claudian-voice] распознавание:', e);
        new Notice('Ошибка распознавания: ' + (e && e.message ? e.message : e), 8000);
        return;
      }
      text = (text || '').trim();
      if (!text) { new Notice('Не расслышал — попробуй ещё раз'); return; }

      // голосовые команды
      const norm = text.toLowerCase().replace(/[.!?,;:]/g, '').trim();
      if (['стоп', 'отмена', 'хватит', 'отбой'].includes(norm)) { new Notice('Отменено'); return; }
      if (['новый чат', 'новая сессия', 'новый разговор'].includes(norm)) {
        this.app.commands.executeCommandById('realclaudian:new-session');
        new Notice('Открыл новую сессию Claudian');
        return;
      }
      if (norm === 'новая вкладка') {
        this.app.commands.executeCommandById('realclaudian:new-tab');
        return;
      }
      await this.insertAndMaybeSend(text);
    } finally {
      if (this.state === 'stt') this.setState('idle');
    }
  }

  cancelRecording(showNotice) {
    if (this.recorder) { try { this.recorder.stop(); } catch (e) {} this.recorder = null; }
    if (this.state === 'rec') {
      this.setState('idle');
      if (showNotice) new Notice('Запись отменена');
    }
  }

  // ── Распознавание ─────────────────────────────────────────────────────────

  async transcribe(pcm16k) {
    if (this.settings.sttProvider === 'yandex') return this.transcribeYandex(pcm16k);
    return this.transcribeOpenai(pcm16k);
  }

  async transcribeOpenai(pcm16k) {
    const key = (this.settings.openaiApiKey || '').trim();
    if (!key) throw new Error('не указан ключ OpenAI (Настройки → Claudian Voice)');
    const wav = pcm16ToWav(pcm16k, 16000);
    const boundary = '----ClaudianVoice' + Math.random().toString(36).slice(2);
    const body = buildMultipart([
      { name: 'file', filename: 'audio.wav', type: 'audio/wav', data: wav },
      { name: 'model', data: this.settings.openaiSttModel || 'whisper-1' },
      { name: 'language', data: (this.settings.language || 'ru').slice(0, 2) },
      { name: 'response_format', data: 'json' },
    ], boundary);
    const resp = await requestUrl({
      url: 'https://api.openai.com/v1/audio/transcriptions',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
      throw: false,
    });
    if (resp.status === 401) throw new Error('OpenAI не принял ключ (401) — проверь ключ');
    if (resp.status === 403) throw new Error('OpenAI отказал (403) — вероятно, нужен включённый VPN');
    if (resp.status >= 400) throw new Error('OpenAI ответил ошибкой ' + resp.status);
    return (resp.json && resp.json.text) || '';
  }

  async transcribeYandex(pcm16k) {
    const key = (this.settings.yandexApiKey || '').trim();
    if (!key) throw new Error('не указан ключ Яндекс SpeechKit (Настройки → Claudian Voice)');
    const lang = this.settings.language === 'ru' ? 'ru-RU' : this.settings.language;
    // лимит Яндекса: 30 сек / 1 МБ — обрезаем при необходимости
    let pcm = pcm16k;
    const maxSamples = 29 * 16000;
    if (pcm.length > maxSamples) { pcm = pcm.subarray(0, maxSamples); new Notice('Запись длиннее 29 сек — Яндекс распознает только начало', 4000); }
    const resp = await requestUrl({
      url: 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=' + encodeURIComponent(lang) + '&format=lpcm&sampleRateHertz=16000&topic=general',
      method: 'POST',
      headers: { 'Authorization': 'Api-Key ' + key, 'Content-Type': 'application/octet-stream' },
      body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
      throw: false,
    });
    if (resp.status === 401) throw new Error('Яндекс не принял ключ (401) — проверь Api-Key');
    if (resp.status >= 400) {
      let msg = '';
      try { msg = (resp.json && (resp.json.error_message || resp.json.message)) || ''; } catch (e) {}
      throw new Error('Яндекс ответил ошибкой ' + resp.status + (msg ? ': ' + msg : ''));
    }
    return (resp.json && resp.json.result) || '';
  }

  // ── Вставка текста в Claudian и отправка ──────────────────────────────────

  async insertAndMaybeSend(text) {
    let ta = this.getVisibleInput();
    if (!ta) {
      // Claudian не открыт — откроем его сами
      this.app.commands.executeCommandById('realclaudian:open-view');
      await new Promise(r => setTimeout(r, 700));
      ta = this.getVisibleInput();
    }
    if (!ta) {
      try { await navigator.clipboard.writeText(text); } catch (e) {}
      new Notice('Окно Claudian не нашлось — распознанный текст скопирован в буфер обмена', 6000);
      return;
    }
    const existing = ta.value;
    ta.value = existing && existing.trim() ? existing.replace(/\s*$/, ' ') + text : text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();

    if (!this.settings.autoSend) { new Notice('Текст вставлен — проверь и отправь Enter'); return; }

    this.lastInputWasVoice = true;
    this.expectingReply = true;
    this.hookUi(); // убедиться, что наблюдатель смотрит на нужное окно

    // у Claudian отправка = Enter (или Cmd+Enter, если так настроено)
    let requireCmd = false;
    try {
      const rc = this.app.plugins.plugins['realclaudian'];
      requireCmd = !!(rc && rc.settings && rc.settings.requireCommandOrControlEnterToSend);
    } catch (e) {}
    const press = (withMod) => ta.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
      metaKey: withMod && Platform.isMacOS, ctrlKey: withMod && !Platform.isMacOS,
    }));
    press(requireCmd);
    // страховка: если текст не ушёл — пробуем с Cmd/Ctrl
    window.setTimeout(() => { if (ta.value.trim()) press(true); }, 350);
  }

  // ── Озвучка ───────────────────────────────────────────────────────────────

  /**
   * Сохранить последний озвученный текст рядом с плагином.
   * Нужно, чтобы разбирать жалобы «прочитало какую-то ерунду» по факту,
   * а не по догадкам: файл видно, слышимое — нет.
   */
  dumpSpoken(text) {
    if (!this.settings.debugDump) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(this.app.vault.adapter.getBasePath(), '.obsidian', 'plugins', 'claudian-voice');
      fs.writeFileSync(path.join(dir, 'last-spoken.txt'), text, 'utf8');
    } catch (e) { /* не критично — озвучку из-за этого не ломаем */ }
  }

  async speak(text) {
    this.stopSpeaking();
    this.speechCancelled = false;
    this.dumpSpoken(text);
    this.setState('speaking');
    try {
      if (this.settings.ttsEngine === 'openai' && (this.settings.openaiApiKey || '').trim()) {
        try { await this.speakOpenai(text); }
        catch (e) {
          console.error('[claudian-voice] OpenAI озвучка:', e);
          new Notice('OpenAI-озвучка не сработала, читаю системным голосом', 4000);
          await this.speakSystem(text);
        }
      } else if (this.settings.ttsEngine === 'yandex' && (this.settings.yandexApiKey || '').trim()) {
        try { await this.speakYandex(text); }
        catch (e) {
          console.error('[claudian-voice] Яндекс-озвучка:', e);
          new Notice('Яндекс-озвучка не сработала, читаю системным голосом', 4000);
          await this.speakSystem(text);
        }
      } else {
        await this.speakSystem(text);
      }
    } finally {
      if (this.state === 'speaking') this.setState('idle');
      this.maybeContinueConversation();
    }
  }

  getVoicesAsync() {
    return new Promise(res => {
      const v = window.speechSynthesis ? speechSynthesis.getVoices() : [];
      if (v.length) return res(v);
      if (!window.speechSynthesis) return res([]);
      const t = window.setTimeout(() => res(speechSynthesis.getVoices()), 1200);
      speechSynthesis.addEventListener('voiceschanged', () => { window.clearTimeout(t); res(speechSynthesis.getVoices()); }, { once: true });
    });
  }

  async speakSystem(text) {
    const voices = await this.getVoicesAsync();
    let voice = null;
    if (this.settings.systemVoice) voice = voices.find(v => v.name === this.settings.systemVoice) || null;
    if (!voice) voice = voices.find(v => /^ru/i.test(v.lang)) || null;
    if ((!voices.length || !voice) && Platform.isMacOS) return this.speakViaSay(text);
    if (!voices.length) { new Notice('Системная озвучка недоступна'); return; }

    await new Promise(resolve => {
      const parts = splitSentences(text);
      let i = 0;
      const next = () => {
        if (this.speechCancelled || i >= parts.length) return resolve();
        const u = new SpeechSynthesisUtterance(parts[i++]);
        if (voice) u.voice = voice;
        u.lang = (voice && voice.lang) || 'ru-RU';
        u.rate = Number(this.settings.ttsRate) || 1;
        u.onend = () => next();
        u.onerror = () => next();
        speechSynthesis.speak(u);
      };
      next();
    });
  }

  /** Запасной вариант для macOS — системная команда say (работает всегда) */
  speakViaSay(text) {
    return new Promise(res => {
      try {
        const { spawn } = require('child_process');
        const rate = Math.round(175 * (Number(this.settings.ttsRate) || 1));
        // пробел в начале — защита от текста, начинающегося с «-» (иначе say примет его за опцию)
        const p = spawn('/usr/bin/say', ['-r', String(rate), ' ' + text]);
        this.sayProc = p;
        p.on('close', () => { this.sayProc = null; res(); });
        p.on('error', () => { this.sayProc = null; res(); });
      } catch (e) { res(); }
    });
  }

  async speakOpenai(text) {
    const key = (this.settings.openaiApiKey || '').trim();
    const resp = await requestUrl({
      url: 'https://api.openai.com/v1/audio/speech',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.openaiTtsModel || 'gpt-4o-mini-tts',
        voice: this.settings.openaiTtsVoice || 'alloy',
        input: text,
        response_format: 'mp3',
      }),
      throw: false,
    });
    if (resp.status >= 400) throw new Error('OpenAI TTS ошибка ' + resp.status);
    if (this.speechCancelled) return;
    const blob = new Blob([resp.arrayBuffer], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    await new Promise((resolve) => {
      const a = new Audio(url);
      this.currentAudio = a;
      a.onended = () => { URL.revokeObjectURL(url); this.currentAudio = null; resolve(); };
      a.onerror = () => { URL.revokeObjectURL(url); this.currentAudio = null; resolve(); };
      a.play().catch(() => resolve());
    });
  }

  /**
   * Озвучка через Yandex SpeechKit — тот же ключ, что и для распознавания.
   * Работает из России без VPN, голос заметно живее системного.
   * Ограничение сервиса — 5000 символов за запрос, поэтому длинный ответ режем на куски.
   */
  async speakYandex(text) {
    const key = (this.settings.yandexApiKey || '').trim();
    if (!key) throw new Error('нет ключа Яндекса');

    if ((this.settings.yandexTtsApi || 'v3') === 'v3') {
      try { return await this.speakYandexV3(text, key); }
      catch (e) {
        console.warn('[claudian-voice] новый движок Яндекса не ответил, пробую старый:', e);
      }
    }
    return this.speakYandexV1(text, key);
  }

  /** Новый движок SpeechKit (v3): живее звучит и дешевле старого */
  async speakYandexV3(text, key) {
    const voice = this.settings.yandexTtsVoice || 'alena';
    const role = this.settings.yandexTtsRole || 'good';
    const speed = Math.min(3, Math.max(0.1, Number(this.settings.ttsRate) || 1));

    // у нового движка жёсткий предел — 250 символов на запрос, поэтому фразу
    // режем на кусочки, озвучиваем их разом и склеиваем в один звук: иначе
    // между кусками слышны паузы
    const pieces = chunkForTts(text, 240);

    const ask = (piece, withRole) => {
      const hints = [{ voice }, { speed }];
      if (withRole && role && role !== 'none') hints.push({ role });
      return requestUrl({
        url: 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis',
        method: 'POST',
        headers: { 'Authorization': 'Api-Key ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: piece,
          hints,
          outputAudioSpec: { rawAudio: { audioEncoding: 'LINEAR16_PCM', sampleRateHertz: V3_SAMPLE_RATE } },
          loudnessNormalizationType: 'LUFS',
        }),
        throw: false,
      });
    };

    const parts = await mapLimit(pieces, 4, async (piece) => {
      if (this.speechCancelled) return new Uint8Array(0);
      let resp = await ask(piece, true);
      // набор настроений у каждого голоса свой: не подошло — читаем без него
      if (resp.status === 400) resp = await ask(piece, false);
      if (resp.status >= 400) throw new Error('Яндекс TTS v3 ошибка ' + resp.status);
      const pcm = decodeV3Pcm(resp.text);
      if (!pcm || !pcm.length) throw new Error('Яндекс TTS v3 вернул пустой звук');
      return pcm;
    });

    if (this.speechCancelled) return;
    const wav = wavFromPcm(concatBytes(parts), V3_SAMPLE_RATE);
    await this.playAudioBuffer(wav.buffer, 'audio/wav');
  }

  /** Старый движок SpeechKit (v1) — запасной путь */
  async speakYandexV1(text, key) {
    const voice = this.settings.yandexTtsVoice || 'alena';
    // скорость сервиса — от 0.1 до 3.0
    const speed = Math.min(3, Math.max(0.1, Number(this.settings.ttsRate) || 1));

    for (const chunk of chunkForTts(text, 3000)) {
      if (this.speechCancelled) return;
      const form = new URLSearchParams();
      form.set('text', chunk);
      form.set('lang', 'ru-RU');
      form.set('voice', voice);
      form.set('format', 'mp3');
      form.set('speed', String(speed));
      if (voice === 'alena' || voice === 'filipp') form.set('emotion', 'neutral');

      const resp = await requestUrl({
        url: 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize',
        method: 'POST',
        headers: {
          'Authorization': 'Api-Key ' + key,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        throw: false,
      });
      if (resp.status >= 400) throw new Error('Яндекс TTS ошибка ' + resp.status);
      if (this.speechCancelled) return;
      await this.playAudioBuffer(resp.arrayBuffer, 'audio/mpeg');
    }
  }

  /** Проиграть готовый звук и дождаться конца (общее для OpenAI и Яндекса) */
  playAudioBuffer(arrayBuffer, mime) {
    const blob = new Blob([arrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    return new Promise((resolve) => {
      const a = new Audio(url);
      this.currentAudio = a;
      const done = () => { URL.revokeObjectURL(url); this.currentAudio = null; resolve(); };
      a.onended = done;
      a.onerror = done;
      a.play().catch(() => done());
    });
  }

  stopSpeaking() {
    this.speechCancelled = true;
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
    if (this.currentAudio) { try { this.currentAudio.pause(); } catch (e) {} this.currentAudio = null; }
    if (this.sayProc) { try { this.sayProc.kill(); } catch (e) {} this.sayProc = null; }
    if (this.state === 'speaking') this.setState('idle');
  }

  maybeContinueConversation() {
    if (!this.settings.conversationMode) return;
    if (!this.settings.autoSend) return;
    if (!this.lastInputWasVoice) return;
    if (this.speechCancelled) return;      // «стоп» = выйти из цикла
    if (this.state !== 'idle') return;
    window.setTimeout(() => { if (this.state === 'idle') this.startRecording(); }, 400);
  }

  // ── Индикация ─────────────────────────────────────────────────────────────

  setState(s) {
    this.state = s;
    this.renderStatus();
    // подсветить кнопки микрофона
    document.querySelectorAll('.cv-mic-btn').forEach(b => {
      b.toggleClass('is-rec', s === 'rec');
      setIcon(b, s === 'rec' ? 'square' : 'mic');
    });
  }

  renderStatus(recSec) {
    if (!this.statusEl) return;
    const el = this.statusEl;
    el.removeClass('cv-rec', 'cv-busy', 'cv-speak');
    if (this.state === 'rec') {
      el.addClass('cv-rec');
      const sec = Math.floor(recSec != null ? recSec : (this.recorder ? this.recorder.durationSec : 0));
      const mm = String(Math.floor(sec / 60));
      const ss = String(sec % 60).padStart(2, '0');
      el.setText('🔴 ' + mm + ':' + ss + ' говорите…');
      el.setAttribute('aria-label', 'Идёт запись. Клик — отменить без отправки');
    } else if (this.state === 'stt') {
      el.addClass('cv-busy');
      el.setText('⏳ распознаю…');
      el.setAttribute('aria-label', 'Распознавание речи');
    } else if (this.state === 'speaking') {
      el.addClass('cv-speak');
      el.setText('🔊 читаю ответ');
      el.setAttribute('aria-label', 'Идёт озвучка. Клик — остановить');
    } else {
      el.setText('🎤');
      el.setAttribute('aria-label', 'Claudian Voice. Клик — начать диктовку');
    }
  }

  onStatusClick() {
    if (this.state === 'rec') this.cancelRecording(true);
    else if (this.state === 'speaking') { this.stopSpeaking(); new Notice('Озвучка остановлена'); }
    else if (this.state === 'idle') this.startRecording();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Экран настроек
// ────────────────────────────────────────────────────────────────────────────

class ClaudianVoiceSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveData(s);
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Claudian Voice — голосовое управление' });

    // ── Распознавание ──
    containerEl.createEl('h3', { text: '1. Распознавание речи (голос → текст)' });

    new Setting(containerEl)
      .setName('Сервис распознавания')
      .setDesc('OpenAI Whisper — лучшее качество, нужен VPN. Яндекс SpeechKit — работает из России без VPN, фразы до 29 секунд.')
      .addDropdown(d => d
        .addOption('openai', 'OpenAI Whisper')
        .addOption('yandex', 'Яндекс SpeechKit')
        .setValue(s.sttProvider)
        .onChange(async v => { s.sttProvider = v; await save(); this.display(); }));

    if (s.sttProvider === 'openai') {
      new Setting(containerEl)
        .setName('Ключ OpenAI')
        .setDesc('Ключ вида sk-… Хранится только на этом компьютере (в git не попадает).')
        .addText(t => {
          t.inputEl.type = 'password';
          t.setPlaceholder('sk-…').setValue(s.openaiApiKey)
            .onChange(async v => { s.openaiApiKey = v.trim(); await save(); });
        });
      new Setting(containerEl)
        .setName('Модель распознавания')
        .addDropdown(d => d
          .addOption('whisper-1', 'whisper-1 (стандарт)')
          .addOption('gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe (дешевле/быстрее)')
          .addOption('gpt-4o-transcribe', 'gpt-4o-transcribe (точнее)')
          .setValue(s.openaiSttModel)
          .onChange(async v => { s.openaiSttModel = v; await save(); }));
    } else {
      new Setting(containerEl)
        .setName('Ключ Яндекс SpeechKit (Api-Key)')
        .setDesc('Api-Key сервисного аккаунта Yandex Cloud с ролью ai.speechkit-stt.user. Хранится только на этом компьютере.')
        .addText(t => {
          t.inputEl.type = 'password';
          t.setPlaceholder('AQVN…').setValue(s.yandexApiKey)
            .onChange(async v => { s.yandexApiKey = v.trim(); await save(); });
        });
    }

    // ── Поведение ──
    containerEl.createEl('h3', { text: '2. Поведение' });

    new Setting(containerEl)
      .setName('Отправлять сразу после распознавания')
      .setDesc('Выключено — текст только вставляется в поле, отправляешь сам клавишей Enter.')
      .addToggle(t => t.setValue(s.autoSend).onChange(async v => { s.autoSend = v; await save(); }));

    new Setting(containerEl)
      .setName('Автостоп по тишине')
      .setDesc('Замолчал — запись сама завершается и уходит на распознавание.')
      .addToggle(t => t.setValue(s.vadEnabled).onChange(async v => { s.vadEnabled = v; await save(); }));

    new Setting(containerEl)
      .setName('Сколько секунд тишины = конец фразы')
      .addSlider(sl => sl.setLimits(1, 5, 0.5).setValue(s.silenceStopSec).setDynamicTooltip()
        .onChange(async v => { s.silenceStopSec = v; await save(); }));

    new Setting(containerEl)
      .setName('Режим диалога')
      .setDesc('После озвучки ответа микрофон включается снова — разговор без рук. Выход: сказать «стоп» или кликнуть по индикатору внизу.')
      .addToggle(t => t.setValue(s.conversationMode).onChange(async v => { s.conversationMode = v; await save(); }));

    // ── Озвучка ──
    containerEl.createEl('h3', { text: '3. Озвучка ответов (текст → голос)' });

    new Setting(containerEl)
      .setName('Озвучивать ответы Claudian автоматически')
      .addToggle(t => t.setValue(s.autoSpeak).onChange(async v => {
        s.autoSpeak = v; await save();
        this.plugin.refreshSpeakButtons();   // значок рядом с микрофоном не должен разъезжаться с этой галочкой
      }));

    new Setting(containerEl)
      .setName('Пересказывать ответ для ушей')
      .setDesc('Письменный ответ со списками и заголовками звучит роботом при любом голосе. '
             + 'С этой настройкой перед озвучкой модель пересказывает его живой речью: главное вперёд, '
             + 'без списков и путей. Занимает 1-3 секунды и стоит доли копейки за ответ.')
      .addToggle(t => t.setValue(s.rewriteForSpeech).onChange(async v => {
        s.rewriteForSpeech = v; await save(); this.display();
      }));

    if (s.rewriteForSpeech) {
      new Setting(containerEl)
        .setName('Ключ Yandex Cloud для пересказа')
        .setDesc('Отдельный ключ с ролью ai.languageModels.user — тот, что для распознавания, сюда не подойдёт.')
        .addText(t => {
          t.inputEl.type = 'password';
          t.setPlaceholder('AQVN…').setValue(s.rewriteApiKey)
            .onChange(async v => { s.rewriteApiKey = v.trim(); await save(); });
        });
      new Setting(containerEl)
        .setName('Каталог Yandex Cloud')
        .addText(t => t.setPlaceholder('b1g…').setValue(s.rewriteFolderId)
          .onChange(async v => { s.rewriteFolderId = v.trim(); await save(); }));
      new Setting(containerEl)
        .setName('Насколько длинный пересказ')
        .setDesc('В символах. 900 — примерно минута речи.')
        .addSlider(sl => sl.setLimits(300, 2000, 100).setValue(s.rewriteTargetChars).setDynamicTooltip()
          .onChange(async v => { s.rewriteTargetChars = v; await save(); }));
      new Setting(containerEl)
        .setName('Проверить пересказ')
        .setDesc('Возьмёт короткий пример и прочитает вслух то, что получилось.')
        .addButton(b => b.setButtonText('Проверить').onClick(async () => {
          const sample = 'Что сделал: починил границы предложений в озвучке, заменил сокращения на слова, '
            + 'латиница теперь читается по-русски. Проверил тестом на пяти случаях. '
            + 'От тебя: перезапустить программу и послушать, стало ли лучше. '
            + 'Версия уже лежит на диске, отдельно ставить ничего не нужно.';
          try {
            const retold = await this.plugin.retellForSpeech(sample);
            new Notice(retold || 'пересказ вернулся пустым', 10000);
            this.plugin.speechCancelled = false;
            await this.plugin.speak(retold || sample);
          } catch (e) {
            new Notice('Не получилось: ' + (e && e.message ? e.message : e), 8000);
          }
        }));
    }

    new Setting(containerEl)
      .setName('Озвучивать только ответы на мои сообщения')
      .setDesc('Защита от чтения вслух старых бесед при переключении вкладок.')
      .addToggle(t => t.setValue(s.onlyAfterMine).onChange(async v => { s.onlyAfterMine = v; await save(); }));

    new Setting(containerEl)
      .setName('Движок озвучки')
      .setDesc('Системный — бесплатно и без интернета. Яндекс — живой голос, работает из России без VPN, ключ тот же что для распознавания (1 342 ₽ за миллион символов ≈ 1-3 ₽ за озвученный ответ). OpenAI — тоже живой, но платно и нужен VPN.')
      .addDropdown(d => d
        .addOption('system', 'Системный голос (бесплатно)')
        .addOption('yandex', 'Яндекс SpeechKit (живой голос, без VPN)')
        .addOption('openai', 'OpenAI TTS (платно, нужен VPN)')
        .setValue(s.ttsEngine)
        .onChange(async v => { s.ttsEngine = v; await save(); this.display(); }));

    if (s.ttsEngine === 'yandex') {
      new Setting(containerEl)
        .setName('Голос Яндекса')
        .setDesc('Алёна — спокойный женский, Филипп — мужской. Ключ берётся из поля «Яндекс SpeechKit» выше.')
        .addDropdown(d => {
          const voices = {
            alena: 'Алёна (женский, спокойный)',
            filipp: 'Филипп (мужской)',
            jane: 'Джейн (женский)',
            omazh: 'Омаж (женский, ниже)',
            zahar: 'Захар (мужской)',
            ermil: 'Ермил (мужской)',
            dasha: 'Даша (женский)',
            julia: 'Юлия (женский)',
            lera: 'Лера (женский)',
            marina: 'Марина (женский)',
            alexander: 'Александр (мужской)',
            kirill: 'Кирилл (мужской)',
            anton: 'Антон (мужской)',
          };
          Object.entries(voices).forEach(([k, label]) => d.addOption(k, label));
          d.setValue(s.yandexTtsVoice || 'alena');
          d.onChange(async v => { s.yandexTtsVoice = v; await save(); });
        });
      new Setting(containerEl)
        .setName('Движок Яндекса')
        .setDesc('Новый звучит живее и стоит вдвое дешевле. Если вдруг не ответит — плагин сам возьмёт старый.')
        .addDropdown(d => d
          .addOption('v3', 'Новый (живее, дешевле)')
          .addOption('v1', 'Старый')
          .setValue(s.yandexTtsApi || 'v3')
          .onChange(async v => { s.yandexTtsApi = v; await save(); this.display(); }));

      if ((s.yandexTtsApi || 'v3') === 'v3') {
        new Setting(containerEl)
          .setName('Настроение голоса')
          .setDesc('У каждого голоса свой набор. Если выбранное настроение голосу не подходит, плагин прочитает без него.')
          .addDropdown(d => d
            .addOption('good', 'Доброжелательно')
            .addOption('neutral', 'Ровно')
            .addOption('none', 'Без настроения')
            .setValue(s.yandexTtsRole || 'good')
            .onChange(async v => { s.yandexTtsRole = v; await save(); }));
      }

      new Setting(containerEl)
        .setName('Проверить голос')
        .setDesc('Скажет короткую фразу выбранным голосом.')
        .addButton(b => b.setButtonText('Прослушать').onClick(async () => {
          try {
            this.plugin.speechCancelled = false;
            await this.plugin.speakYandex('Проверка голоса. Я читаю ответы Клодиана вслух.');
          } catch (e) {
            new Notice('Не получилось: ' + (e && e.message ? e.message : e), 6000);
          }
        }));
    } else if (s.ttsEngine === 'system') {
      const voiceSetting = new Setting(containerEl)
        .setName('Системный голос')
        .setDesc('Пусто — автоматически первый русский. Хорошие русские голоса ставятся в Настройках macOS → Универсальный доступ → Проговаривание → Голос.');
      voiceSetting.addDropdown(async d => {
        d.addOption('', 'Авто (русский)');
        const voices = await this.plugin.getVoicesAsync();
        voices
          .filter(v => /^(ru|en)/i.test(v.lang))
          .forEach(v => d.addOption(v.name, v.name + ' (' + v.lang + ')'));
        d.setValue(s.systemVoice);
        d.onChange(async v => { s.systemVoice = v; await save(); });
      });
    } else {
      new Setting(containerEl)
        .setName('Голос OpenAI')
        .addDropdown(d => {
          ['alloy', 'ash', 'echo', 'fable', 'nova', 'onyx', 'shimmer'].forEach(v => d.addOption(v, v));
          d.setValue(s.openaiTtsVoice).onChange(async v => { s.openaiTtsVoice = v; await save(); });
        });
      new Setting(containerEl)
        .setName('Модель озвучки OpenAI')
        .addDropdown(d => d
          .addOption('gpt-4o-mini-tts', 'gpt-4o-mini-tts (дешевле)')
          .addOption('tts-1', 'tts-1')
          .addOption('tts-1-hd', 'tts-1-hd (качественнее)')
          .setValue(s.openaiTtsModel)
          .onChange(async v => { s.openaiTtsModel = v; await save(); }));
    }

    new Setting(containerEl)
      .setName('Скорость речи')
      .addSlider(sl => sl.setLimits(0.5, 2, 0.1).setValue(s.ttsRate).setDynamicTooltip()
        .onChange(async v => { s.ttsRate = v; await save(); }));

    new Setting(containerEl)
      .setName('Пропускать код и таблицы')
      .setDesc('Вместо чтения кода вслух скажет «код — на экране».')
      .addToggle(t => t.setValue(s.skipCodeBlocks).onChange(async v => { s.skipCodeBlocks = v; await save(); }));

    new Setting(containerEl)
      .setName('Максимум символов озвучки')
      .setDesc('Длинные ответы обрезаются со словами «дальше читай на экране». 2500 знаков ≈ 3 минуты речи.')
      .addSlider(sl => sl.setLimits(500, 8000, 250).setValue(s.maxSpeakChars).setDynamicTooltip()
        .onChange(async v => { s.maxSpeakChars = v; await save(); }));

    // ── Подсказка ──
    const help = containerEl.createEl('div', { cls: 'cv-help' });
    help.createEl('h3', { text: 'Как пользоваться' });
    const ul = help.createEl('ul');
    ul.createEl('li', { text: '🎤 — кнопка на левой панели, в панели инструментов чата Claudian или значок внизу окна.' });
    ul.createEl('li', { text: 'Сказал фразу → пауза → текст распознан и отправлен → ответ прозвучит голосом.' });
    ul.createEl('li', { text: 'Голосовые команды: «стоп» / «отмена» — не отправлять; «новый чат» — новая сессия Claudian.' });
    ul.createEl('li', { text: 'Клик по индикатору внизу: во время записи — отмена, во время озвучки — тишина, в покое — начать запись.' });
    ul.createEl('li', { text: 'Горячие клавиши можно назначить: Настройки → Горячие клавиши → «Claudian Voice».' });
  }
}

module.exports = ClaudianVoicePlugin;
