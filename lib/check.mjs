#!/usr/bin/env node
/**
 * Линтер постов для Threads.
 *
 * Использование:
 *   node lib/check.mjs черновик.md
 *   node lib/check.mjs черновик.md --json
 *   cat post.txt | node lib/check.mjs
 *
 * Коды возврата: 0 — можно публиковать, 1 — есть блокирующее (переписать),
 *                2 — ошибка запуска (нет файла, битый config).
 *
 * ЧТО ОН ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ
 * Проверяет ФОРМУ: лимиты площадки и признаки машинного текста.
 * НЕ проверяет ПРАВДУ: настоящая ли цифра в посте, знает только человек.
 *
 * ДВА УРОВНЯ
 *   БЛОКИРУЮЩЕЕ  — нарушает лимит площадки или гарантированно вредит.
 *                  Пост не отдаётся владельцу, пока не исправлено.
 *   ПРЕДУПРЕЖДЕНИЕ — вероятная проблема, решение за автором.
 *
 * КАК ПРАВИТЬ ПРАВИЛА
 *   Свои слова и фразы НЕ НАДО дописывать в код — они лежат в
 *   config/voice.json (см. ниже). Файл необязателен: без него работают
 *   правила по умолчанию.
 *
 *   RU_MARKERS / EN_MARKERS — лексика, считается по ПЛОТНОСТИ:
 *     1 слово — норма, 2 — предупреждение, 3+ — переписать пост.
 *     Так задумано: одно слово из списка ещё не признак машины, кластер — признак.
 *   FORBIDDEN — конструкции, которые режутся с одного попадания.
 *     Добавляя правило, пишите пару [регулярка, 'человеческое объяснение'].
 *   Пороги длины и эмодзи — в теле analyze(), помечены номерами пунктов.
 *
 * ФОРМАТ config/voice.json (все поля необязательны):
 *   {
 *     "lang": "ru",                       // ru | en | auto (по умолчанию auto)
 *     "forbiddenWords": ["дедлайн", "кейс"],   // слова владельца: блокирующее
 *     "stopPhrases": ["мы лидеры рынка"],      // свои стоп-фразы: блокирующее
 *     "warnWords": ["решение"],                // мягкий список: предупреждение
 *     "extraMarkers": ["синергия"],            // добавить к ИИ-маркерам
 *     "allowMarkers": ["позволяет"],           // убрать из ИИ-маркеров
 *     "limit": 500,                            // лимит символов поста
 *     "maxEmoji": 2, "maxDashes": 2, "maxHashtags": 1,
 *     "firstLineMax": 120,
 *     "requireHook": true                      // проверять крючок в 1-й строке
 *   }
 *
 * ⚠️ Добавив правило, прогоните примеры: references/*.md и generated/*.md —
 *   они должны проходить без блокирующих. Ложное срабатывание хуже пропуска:
 *   линтер, который ругается на хороший текст, перестают слушать.
 *
 * ДВА РЕЖИМА РАЗБОРА ФАЙЛА (важно понимать, что проверяется)
 *   ФАЙЛ-ПЛАН — если в файле есть хотя бы один ```-блок, публикуемым считается
 *     ТОЛЬКО содержимое блоков. Шапка файла, заголовки «## ПН — F1» и пометки
 *     для себя отбрасываются целиком; про их количество говорится отдельной
 *     строкой, чтобы забытый без блока пост не прошёл незамеченным.
 *   ЧЕРНОВИК — если фенсов нет вовсе, проверяется весь текст (человек подал
 *     просто пост). Срезаются только frontmatter и строки-заголовки.
 *
 * Тред разделяется строкой '---'; каждый пост проверяется отдельно.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  lang: 'auto',
  limit: 500,
  maxEmoji: 2,
  maxDashes: 2,
  maxHashtags: 1,
  firstLineMax: 120,
  requireHook: true,
  forbiddenWords: [],
  stopPhrases: [],
  warnWords: [],
  extraMarkers: [],
  allowMarkers: [],
};

// Лексические маркеры ИИ: считаются по плотности (3+ на пост = переписать).
const RU_MARKERS = [
  'ключевой', 'важно отметить', 'стоит отметить', 'комплексн', 'эффективн',
  'оптимизиров', 'внедрить', 'реализовать', 'обеспечить', 'качественн',
  'современн', 'инновацион', 'надёжн', 'надежн', 'уникальн', 'грамотн',
  'осуществл', 'является', 'позволяет', 'на сегодняшний день', 'в современном мире',
];
const EN_MARKERS = [
  'leverage', 'utilize', 'facilitate', 'streamline', 'robust', 'seamless',
  'delve', 'unlock', 'harness', 'foster', 'landscape', 'ecosystem',
  'fundamentally', 'essentially', 'ultimately', 'crucial', 'notably',
  'comprehensive', 'insights', 'significant', 'empower', 'elevate',
];

// Конструкции, которые вычищаются с одного попадания.
const FORBIDDEN = [
  [/не просто [^,.]{1,40}, а /i, 'калька "It\'s not just X, it\'s Y"'],
  [/it'?s not just .{1,40}, it'?s /i, '"It\'s not just X, it\'s Y"'],
  [/^\s*(что в итоге|результат|итог|вывод)\?\s*$/im, 'мостик-раскрытие отдельной строкой'],
  [/^\s*(the (result|outcome|answer|lesson|catch|truth))\?\s*$/im, 'reveal bridge'],
  [/давайте разбер[её]мся|разбер[её]м по порядку|итак,? поехали/i, 'дежурный переход'],
  [/скажу честно|если честно|не побоюсь этого слова|честно говоря/i, 'наигранная искренность'],
  [/let me be (honest|real)|i'?ll be honest|real talk|not gonna lie|honestly\?/i, 'performed sincerity'],
  [/важно понимать,? что/i, 'пустая связка'],
  [/в этой статье|в этом посте я расскажу/i, 'не бывает в живом посте'],
  [/game-?changer|deep dive|at the end of the day|move the needle/i, 'мёртвая фраза'],
  [/(мышление|масштабирование|выход на новый уровень|прокачать)/i, 'инфоцыганский лексикон'],
  [/^\s*(что думаете|ваше мнение|thoughts|what do you think)\?\s*$/im, 'мёртвый вопрос в конце'],
  [/подписывайтесь|ставьте лайк|репостните,? если/i, 'engagement-bait, алгоритм душит'],
];

// Вводная вода: пост, который начинается с этого, тратит крючок на разгон.
const FILLER_OPENERS = [
  /^(в современном мире|на сегодняшний день|как известно|все мы знаем|многие( из вас)? знают)/i,
  /^(сегодня (я )?(хочу|хотел бы|расскажу|поговорим)|хочу (рассказать|поделиться)|поделюсь)/i,
  /^(немного|пару слов|несколько слов) о/i,
  /^(думаю,? (что )?)?(каждый|любой) (владелец|предприниматель|человек)/i,
  /^(итак|что ж|ну что)\b/i,
  /^(in (today'?s|the modern) (world|landscape)|as we all know|we all know that)/i,
  /^(today i (want|wanted|would like) to|i wanted to (share|talk))/i,
];

const HELP = `
Линтер постов для Threads.

  node lib/check.mjs <файл>            проверить файл (.md или .txt)
  node lib/check.mjs <файл> --json     то же, но результат в JSON
  cat пост.txt | node lib/check.mjs    проверить то, что подали на вход
  node lib/check.mjs --help            эта справка

ЧТО ПОДАТЬ НА ВХОД
  Либо один пост обычным текстом, либо файл-план: посты разделены
  строкой из трёх дефисов (---), а публикуемый текст каждого поста
  лежит в блоке с тройными обратными кавычками.

  Если в файле есть хотя бы один такой блок, проверяется ТОЛЬКО его
  содержимое: шапка файла и заголовки «## ПН — F1» не публикуются,
  поэтому и не проверяются. Сколько блоков отброшено — скрипт скажет,
  чтобы забытый без кавычек пост не прошёл мимо проверки.
  Если фенсов в файле нет вовсе, проверяется весь текст целиком.

НАСТРОЙКИ (необязательно)
  config/voice.json рядом с папкой lib — свои запрещённые слова,
  стоп-фразы и пороги. Без файла работают правила по умолчанию.
  Путь можно задать явно: --config путь/к/voice.json

КОДЫ ВОЗВРАТА
  0  можно публиковать
  1  есть блокирующее — переписать
  2  ошибка запуска (файла нет, config битый)
`;

function fail(msg, hint) {
  console.error(`\nОШИБКА: ${msg}`);
  if (hint) console.error(hint);
  console.error('\nПодсказка: node lib/check.mjs --help\n');
  process.exit(2);
}

function toArray(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    fail(`в config поле "${field}" должно быть списком строк.`,
      `Сейчас там: ${JSON.stringify(v)}. Нужно, например: "${field}": ["слово", "фраза"]`);
  }
  return v.map(String).filter(s => s.trim().length > 0);
}

function toNumber(v, field, dflt) {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    fail(`в config поле "${field}" должно быть положительным числом.`,
      `Сейчас там: ${JSON.stringify(v)}`);
  }
  return n;
}

/** Ищет config/voice.json: явный путь, рядом с lib, в корне проекта, в cwd. */
function findConfigPath(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) {
      fail(`файл настроек не найден: ${explicit}`,
        'Проверьте путь или запустите без --config — тогда возьмутся правила по умолчанию.');
    }
    return explicit;
  }
  const candidates = [
    join(HERE, '..', 'config', 'voice.json'),
    join(HERE, 'config', 'voice.json'),
    resolve('config', 'voice.json'),
  ];
  return candidates.find(p => existsSync(p)) || null;
}

function loadConfig(explicit) {
  const path = findConfigPath(explicit);
  if (!path) return { ...DEFAULTS, _source: null };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`не удалось прочитать настройки ${path}: ${e.message}`,
      'Это должен быть корректный JSON. Проверьте запятые и кавычки, либо удалите файл — линтер будет работать на правилах по умолчанию.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`настройки ${path} должны быть объектом JSON вида { "lang": "ru", ... }.`);
  }

  const lang = parsed.lang === undefined ? 'auto' : String(parsed.lang);
  if (!['ru', 'en', 'auto'].includes(lang)) {
    fail(`в config поле "lang" может быть только "ru", "en" или "auto". Сейчас: ${JSON.stringify(parsed.lang)}`);
  }

  return {
    _source: path,
    lang,
    limit: toNumber(parsed.limit, 'limit', DEFAULTS.limit),
    maxEmoji: toNumber(parsed.maxEmoji, 'maxEmoji', DEFAULTS.maxEmoji),
    maxDashes: toNumber(parsed.maxDashes, 'maxDashes', DEFAULTS.maxDashes),
    maxHashtags: toNumber(parsed.maxHashtags, 'maxHashtags', DEFAULTS.maxHashtags),
    firstLineMax: toNumber(parsed.firstLineMax, 'firstLineMax', DEFAULTS.firstLineMax),
    requireHook: parsed.requireHook === undefined ? true : Boolean(parsed.requireHook),
    forbiddenWords: toArray(parsed.forbiddenWords, 'forbiddenWords'),
    stopPhrases: toArray(parsed.stopPhrases, 'stopPhrases'),
    warnWords: toArray(parsed.warnWords, 'warnWords'),
    extraMarkers: toArray(parsed.extraMarkers, 'extraMarkers'),
    allowMarkers: toArray(parsed.allowMarkers, 'allowMarkers'),
  };
}

/** Набор ИИ-маркеров под язык, с учётом добавленных и разрешённых владельцем. */
function buildMarkers(cfg, raw) {
  let lang = cfg.lang;
  if (lang === 'auto') lang = /[а-яё]/i.test(raw) ? 'ru' : 'en';
  const base = lang === 'ru' ? [...RU_MARKERS, ...EN_MARKERS]
    : lang === 'en' ? [...EN_MARKERS, ...RU_MARKERS]
      : [...RU_MARKERS, ...EN_MARKERS];
  const allow = new Set(cfg.allowMarkers.map(s => s.toLowerCase()));
  const markers = [...base, ...cfg.extraMarkers]
    .map(s => s.toLowerCase())
    .filter(m => !allow.has(m));
  return { lang, markers: [...new Set(markers)] };
}

/**
 * Крючок в первой строке: вопрос, цифра или противоречие.
 * Мягкая проверка (предупреждение): формул больше, чем можно перечислить.
 */
function hookKind(line) {
  if (/\?/.test(line)) return 'вопрос';
  if (/\d/.test(line)) return 'цифра';
  if (/\b(но|однако|а оказалось|при этом|хотя|вместо|зато|только)\b/i.test(line)) return 'противоречие';
  if (/\b(but|however|turns out|except|instead|yet)\b/i.test(line)) return 'противоречие';
  if (/(не работал|не работает|сломал|потерял|терял|упал|падал|ошиб|провал|оказал|нельзя|невозможно)/i.test(line)) return 'проблема';
  if (/(broke|broken|lost|failed|wrong|couldn'?t|can'?t|nobody|never)/i.test(line)) return 'проблема';
  return null;
}

/**
 * Вытаскивает из файла только то, что реально уйдёт в Threads.
 *
 * Два режима, и это важно:
 *
 * 1. ФАЙЛ-ПЛАН — в файле есть хотя бы один ```-блок. Тогда публикуемое лежит
 *    ТОЛЬКО в блоках, а всё остальное (шапка файла, заголовки «## ПН — F1»,
 *    пометки для себя) — служебное и отбрасывается ЦЕЛИКОМ. Раньше блок без
 *    фенса проверялся как пост: шапка файла становилась «постом 1», сбивала
 *    нумерацию («что не так в посте 3» указывало не на тот пост) и попадала
 *    в сводку длин.
 *
 * 2. ОДИНОЧНЫЙ ЧЕРНОВИК — фенсов в файле нет вовсе. Тогда проверяется весь
 *    текст: человек подал просто пост, и молча выкинуть его нельзя.
 *    Срезаются только frontmatter и markdown-заголовки — публиковать их
 *    всё равно нельзя.
 */
function extractPosts(raw) {
  const hasFence = /^[ \t]*```/m.test(raw);
  const blocks = raw.split(/^---$/m);
  const posts = [];
  let dropped = 0;

  if (hasFence) {
    for (const block of blocks) {
      // В одном блоке может лежать несколько ```-вставок (пост + ответ).
      const fences = [...block.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
        .map(m => m[1].trim())
        .filter(Boolean);
      if (fences.length) posts.push(...fences);
      else if (block.trim()) dropped++;
    }
    return { posts, dropped, mode: 'план' };
  }

  // Одиночный черновик: убираем frontmatter и строки-заголовки.
  let text = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  text = text.split('\n').filter(l => !/^#{1,6}\s/.test(l)).join('\n').trim();
  if (text) posts.push(text);
  return { posts, dropped: 0, mode: 'черновик' };
}

export function analyze(raw, cfg = { ...DEFAULTS, _source: null }) {
  const { posts, dropped, mode } = extractPosts(raw);

  const problems = [];
  const warnings = [];
  const notes = [];
  const { lang, markers } = buildMarkers(cfg, raw);

  if (!posts.length) {
    problems.push('в файле нет ни одного поста. Проверьте, что текст не пуст и ```-блоки закрыты.');
    return { problems, warnings, notes, posts, lang, mode, dropped, config: cfg._source };
  }

  // Человек должен знать, что часть файла не проверялась, иначе он решит,
  // что линтер одобрил текст, до которого просто не дошёл.
  if (dropped) {
    warnings.push(`пропущено служебных блоков без \`\`\`-блока: ${dropped}. Они не проверялись и не публикуются. Если это был пост — оберните его в \`\`\`.`);
  }

  posts.forEach((post, i) => {
    const n = posts.length > 1 ? `пост ${i + 1}: ` : '';
    const lower = post.toLowerCase();

    // 1. Длина
    if (post.length > cfg.limit) {
      problems.push(`${n}${post.length} символов из ${cfg.limit}. Сократить или разбить на тред.`);
    }

    // 2. Первая строка несёт весь вес
    const firstLine = post.split('\n')[0].trim();
    if (i === 0) {
      if (firstLine.length > cfg.firstLineMax) {
        warnings.push(`первая строка ${firstLine.length} символов — лента обрежет. Цель: до ~100.`);
      }
      if (/^(привет|всем привет|hi|hey everyone|доброе утро)/i.test(firstLine)) {
        problems.push('пост начинается с приветствия — прокрутка не остановлена.');
      }

      // 2а. Охват: крючок в первой строке и вводная вода
      const filler = FILLER_OPENERS.find(re => re.test(firstLine));
      if (filler) {
        problems.push('пост начинается с вводной воды («в современном мире», «хочу рассказать») — первая строка потрачена на разгон, а её читают вместо всего поста.');
      }
      if (cfg.requireHook) {
        const kind = hookKind(firstLine);
        if (kind) {
          notes.push(`крючок в первой строке: ${kind}.`);
        } else if (!filler) {
          warnings.push('в первой строке нет крючка: ни вопроса, ни цифры, ни противоречия. Лента показывает только её — без крючка охвата не будет.');
        }
      }
    }

    // 3. Ссылка в первом посте режет охват
    if (i === 0 && /https?:\/\//.test(post)) {
      problems.push('внешняя ссылка в первом посте режет охват. Перенести в ответ на свой пост.');
    }

    // 4. Хэштеги: платформа принимает один
    const tags = post.match(/#[\wа-яё]+/gi) || [];
    if (tags.length > cfg.maxHashtags) {
      problems.push(`${n}${tags.length} хэштега. Threads принимает только ${cfg.maxHashtags}.`);
    }

    // 5. Эмодзи
    const emoji = (post.match(/\p{Extended_Pictographic}/gu) || []).length;
    if (emoji > cfg.maxEmoji) warnings.push(`${n}${emoji} эмодзи. Для B2B достаточно 0–1.`);

    // 6. Тире
    const dashes = (post.match(/—/g) || []).length;
    if (dashes > cfg.maxDashes) {
      warnings.push(`${n}${dashes} длинных тире. В русском допустимо до ${cfg.maxDashes}, дальше — признак ИИ.`);
    }
    if (/--|–\s/.test(post)) warnings.push(`${n}двойной дефис или короткое тире между частями — заменить.`);

    // 7. Плотность лексических маркеров
    const hits = markers.filter(m => lower.includes(m));
    if (hits.length >= 3) {
      problems.push(`${n}${hits.length} ИИ-маркеров (${hits.slice(0, 4).join(', ')}) — переписать пост целиком.`);
    } else if (hits.length === 2) {
      warnings.push(`${n}2 маркера (${hits.join(', ')}) — пограничная плотность.`);
    }

    // 8. Запрещённые конструкции
    for (const [re, why] of FORBIDDEN) {
      if (re.test(post)) problems.push(`${n}${why}.`);
    }

    // 8а. Списки владельца из config
    for (const w of cfg.forbiddenWords) {
      if (lower.includes(w.toLowerCase())) {
        problems.push(`${n}слово «${w}» запрещено вашими настройками (config/voice.json → forbiddenWords).`);
      }
    }
    for (const p of cfg.stopPhrases) {
      if (lower.includes(p.toLowerCase())) {
        problems.push(`${n}стоп-фраза «${p}» из ваших настроек (config/voice.json → stopPhrases).`);
      }
    }
    for (const w of cfg.warnWords) {
      if (lower.includes(w.toLowerCase())) {
        warnings.push(`${n}слово «${w}» из вашего мягкого списка (config/voice.json → warnWords).`);
      }
    }

    // 9. Канцелярит
    const kanc = post.match(/\b\w+(ение|ание)\s+\w+(ии|ия|а|ов)\b/gi) || [];
    if (kanc.length) warnings.push(`${n}канцелярит: «${kanc[0]}» — вернуть глагол и деятеля.`);
  });

  // 10. Конкретная цифра — главное топливо доверия
  const hasNumber = /\d/.test(raw) ||
    /(^|[\s(«"'])(месяц\w*|недел[юия]\w*|год[аыу]?|лет|дн[ейя]|день|час[аовы]*|сутки|раз|разa|дважды|трижды|втрое|вдвое|половин\w+|перв\w+|втор\w+|трет\w+)($|[\s.,!?:;)»"'])/i.test(raw);
  if (!hasNumber) warnings.push('в посте нет ни одной цифры. Конкретика убеждает сильнее прилагательных.');

  // 11. Приглашение к разговору: реплаи — самый весомый сигнал
  const hasInvite = /\?/.test(raw) ||
    /напиш|скинь|проверь|провер(ять|ить)|посмотр|гляньте|глянь|попробуй|откройте|сравните|расскажите|поделитесь|reply|send me|check|try it|tell me|open your/i.test(raw);
  if (!hasInvite) warnings.push('нет ни вопроса, ни призыва к действию. Реплаи — самый весомый сигнал алгоритма.');

  if (posts.length > 1) {
    notes.push(`тред из ${posts.length} постов (оптимум для обучающего треда 4–7).`);
    if (posts.length > 9) warnings.push('тред длиннее 9 постов — дочитываемость падает.');
  }
  notes.push(`длина: ${posts.map(p => p.length).join(', ')} симв.`);
  notes.push(`режим: ${mode}${mode === 'план' ? ` (проверялось только содержимое \`\`\`-блоков)` : ' (весь текст целиком)'}.`);
  notes.push(`язык проверки: ${lang}${cfg.lang === 'auto' ? ' (определён автоматически)' : ' (из настроек)'}.`);
  if (cfg._source) notes.push(`настройки: ${cfg._source}`);

  return { problems, warnings, notes, posts, lang, mode, dropped, config: cfg._source };
}

function readStdin() {
  if (process.stdin.isTTY) {
    console.error('\nОШИБКА: нечего проверять — файл не указан, и на вход ничего не подано.');
    console.error(HELP);
    process.exit(2);
  }
  try {
    return readFileSync(0, 'utf8');
  } catch (e) {
    fail(`не удалось прочитать текст со входа: ${e.message}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  const asJson = argv.includes('--json');
  const cfgIdx = argv.indexOf('--config');
  let explicitCfg = null;
  if (cfgIdx !== -1) {
    explicitCfg = argv[cfgIdx + 1];
    if (!explicitCfg || explicitCfg.startsWith('--')) {
      fail('после --config нужен путь к файлу настроек.', 'Например: --config config/voice.json');
    }
  }

  const files = argv.filter((a, idx) =>
    !a.startsWith('--') && a !== '-h' && !(cfgIdx !== -1 && idx === cfgIdx + 1));
  if (files.length > 1) {
    fail(`указано ${files.length} файлов, а линтер проверяет по одному.`,
      `Запустите отдельно: ${files.map(f => `node lib/check.mjs ${f}`).join(' ; ')}`);
  }

  const file = files[0];
  let raw;
  if (file) {
    if (!existsSync(file)) {
      fail(`файл не найден: ${file}`,
        'Проверьте путь. Если вы хотели подать текст напрямую: cat пост.txt | node lib/check.mjs');
    }
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      fail(`не удалось прочитать файл ${file}: ${e.message}`);
    }
  } else {
    raw = readStdin();
  }

  if (!raw.trim()) {
    fail('текст пуст — проверять нечего.', 'Подайте файл с постом или текст на вход.');
  }

  const cfg = loadConfig(explicitCfg);
  const result = analyze(raw.trim(), cfg);
  const { problems, warnings, notes } = result;

  if (asJson) {
    console.log(JSON.stringify({
      ok: problems.length === 0,
      exitCode: problems.length ? 1 : 0,
      file: file || '(stdin)',
      config: result.config,
      lang: result.lang,
      mode: result.mode,
      droppedBlocks: result.dropped,
      posts: result.posts.map((p, i) => ({ index: i + 1, length: p.length, text: p })),
      problems,
      warnings,
      notes,
    }, null, 2));
    process.exit(problems.length ? 1 : 0);
  }

  console.log('\n=== ПРОВЕРКА ПОСТА ===\n');
  notes.forEach(x => console.log(`  · ${x}`));
  console.log();
  if (problems.length) {
    console.log('  БЛОКИРУЮЩЕЕ:');
    problems.forEach(x => console.log(`   ✗ ${x}`));
    console.log();
  }
  if (warnings.length) {
    console.log('  ПРЕДУПРЕЖДЕНИЯ:');
    warnings.forEach(x => console.log(`   ! ${x}`));
    console.log();
  }
  if (!problems.length && !warnings.length) console.log('  ✓ Замечаний нет.\n');

  console.log(problems.length ? '  ИТОГ: переписать.\n' : '  ИТОГ: можно публиковать.\n');
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
