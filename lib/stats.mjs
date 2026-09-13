#!/usr/bin/env node
/**
 * Анализ собственного трекера публикаций (CSV).
 *
 * Отвечает на один вопрос: КАКАЯ СВЯЗКА РАБОТАЕТ — формула × тема × время.
 * И честно говорит «данных мало», когда их мало. Это главное свойство скрипта:
 * на трёх постах разница между формулами — случайность, и выводы из неё
 * дороже, чем отсутствие выводов.
 *
 * ⚠️ В сеть не ходит. Читает только ваш файл трекера.
 *
 * Использование:
 *   node lib/stats.mjs generated/tracker.csv
 *   node lib/stats.mjs tracker.csv --json
 *   node lib/stats.mjs tracker.csv --metric ответы
 *   node lib/stats.mjs tracker.csv --md отчёт.md
 *
 * Коды возврата: 0 — разобрано (в том числе «данных мало»: это не ошибка),
 *                1 — файл прочитан, но ни одной строки данных не распознано,
 *                2 — ошибка запуска (нет файла, нет нужных колонок).
 *
 * ФОРМАТ ТРЕКЕРА
 * Первая строка — шапка. Названия колонок понимаются по-русски и по-английски,
 * порядок любой, лишние колонки игнорируются. Рабочий минимум: дата + одна
 * колонка результата.
 *
 *   дата,пост,формула,язык,тема,охват,комментарии,переходы_в_личку,диагностики,заявки
 *   2026-09-01,474 товара невидимы,F1,ru,SEO,7400,41,6,2,1
 *
 * Колонка «дата» может содержать время: 2026-09-01 09:12 или 2026-09-01T09:12.
 * Тогда скрипт сам считает час и день недели — это и есть «время публикации».
 * Если времени нет, срез по времени просто не строится (а не выдумывается).
 *
 * ПОРОГИ, И ПОЧЕМУ ОНИ ТАКИЕ
 *   MIN_ROWS = 10        меньше — не считаем закономерностей вообще
 *   MIN_GROUP = 3        группа меньше 3 постов не сравнивается с другими
 *   MIN_PAIR = 3         связка «формула × тема» — тоже от 3 постов
 * Цифры не из статистики, а из осторожности: на таких объёмах медиана ещё
 * шумит, поэтому всё, что ниже порога, показывается как наблюдение, но
 * НЕ называется лучшим. Порог можно поднять: --min 15.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const MIN_ROWS = 10;
const MIN_GROUP = 3;
const MIN_PAIR = 3;

const HELP = `
Анализ своего трекера публикаций Threads. В сеть не ходит.

  node lib/stats.mjs <трекер.csv>              разбор и выводы
  node lib/stats.mjs <трекер.csv> --json       результат в JSON
  node lib/stats.mjs <трекер.csv> --md <файл>  отчёт в markdown
  node lib/stats.mjs <трекер.csv> --metric <колонка>
                                               по какому столбцу считать
                                               (охват, комментарии, заявки…)
  node lib/stats.mjs <трекер.csv> --min 15     поднять порог «данных мало»
  node lib/stats.mjs --help                    эта справка

ЧТО ПОДАТЬ НА ВХОД
  CSV с первой строкой-шапкой. Разделитель запятая, точка с запятой или таб.
  Названия колонок понимаются по-русски, порядок любой, лишние игнорируются:

    дата,пост,формула,язык,тема,охват,комментарии,переходы_в_личку,заявки
    2026-09-01 09:12,474 товара невидимы,F1,ru,SEO,7400,41,6,1

  Рабочий минимум: колонка даты и одна колонка результата (охват или
  комментарии). Если в дате есть время — скрипт сам посчитает час и день
  недели и добавит срез по времени публикации.

ЧЕСТНОСТЬ ВЫВОДОВ
  Меньше ${MIN_ROWS} строк — скрипт скажет «данных мало» и не будет называть
  лучшую связку. Группы меньше ${MIN_GROUP} постов показываются, но лучшими
  не объявляются. Это сделано намеренно: вывод из трёх постов вреднее,
  чем его отсутствие.

КОДЫ ВОЗВРАТА
  0  разобрано (в том числе «данных мало» — это не ошибка)
  1  файл прочитан, но строк с данными нет
  2  ошибка запуска (файла нет, нет нужных колонок)
`;

function fail(msg, hint) {
  console.error(`\nОШИБКА: ${msg}`);
  if (hint) console.error(hint);
  console.error('\nПодсказка: node lib/stats.mjs --help\n');
  process.exit(2);
}

// Синонимы колонок. Ключ слева — как скрипт зовёт колонку внутри.
const COLUMNS = {
  date: ['дата', 'date', 'время', 'timestamp', 'опубликован', 'когда'],
  post: ['пост', 'post', 'текст', 'text', 'название', 'заголовок', 'title'],
  formula: ['формула', 'formula', 'хук', 'hook', 'тип'],
  topic: ['тема', 'topic', 'theme', 'рубрика'],
  lang: ['язык', 'lang', 'language'],
  time: ['час', 'hour', 'время_публикации', 'time'],
  weekday: ['день', 'день_недели', 'weekday', 'dow'],
  views: ['охват', 'views', 'просмотры', 'просмотров', 'показы', 'impressions', 'reach'],
  likes: ['лайки', 'likes', 'лайков'],
  replies: ['комментарии', 'ответы', 'replies', 'comments', 'коммент', 'комменты', 'ответов'],
  reposts: ['репосты', 'reposts', 'репостов'],
  dm: ['переходы_в_личку', 'переходы', 'личка', 'dm', 'dms'],
  calls: ['диагностики', 'диагностика', 'звонки', 'calls', 'созвоны'],
  leads: ['заявки', 'leads', 'заявок', 'лиды'],
};

// Что считаем результатом, в порядке предпочтения, если человек не выбрал сам.
const METRIC_ORDER = ['views', 'replies', 'leads', 'dm', 'calls', 'likes', 'reposts'];
const METRIC_RU = {
  views: 'охват', replies: 'комментарии', likes: 'лайки', reposts: 'репосты',
  dm: 'переходы в личку', calls: 'диагностики', leads: 'заявки',
};
const FIELD_RU = { formula: 'формула', topic: 'тема', lang: 'язык', slot: 'время публикации', weekday: 'день недели' };
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

function columnKey(header) {
  const h = String(header).trim().toLowerCase()
    .replace(/^["']|["']$/g, '').replace(/\s+/g, '_');
  for (const [key, names] of Object.entries(COLUMNS)) {
    if (names.includes(h)) return key;
  }
  return null;
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return `${n} ${many}`;
  if (b > 1 && b < 5) return `${n} ${few}`;
  if (b === 1) return `${n} ${one}`;
  return `${n} ${many}`;
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().replace(/[\s\u00a0\u202f]/g, '');
  if (!s || s === '-' || s === '—') return null;
  const km = s.match(/^([\d.,]+)([kKкКmMмМ])$/);
  if (km) {
    const base = Number(km[1].replace(',', '.'));
    return Number.isFinite(base) ? Math.round(base * (/[kKкК]/.test(km[2]) ? 1000 : 1e6)) : null;
  }
  const n = Number(s.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function splitDelimited(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim().replace(/^["']|["']$/g, ''));
}

function guessDelimiter(line) {
  const c = [['\t', (line.match(/\t/g) || []).length],
    [';', (line.match(/;/g) || []).length],
    [',', (line.match(/,/g) || []).length]];
  c.sort((a, b) => b[1] - a[1]);
  return c[0][1] > 0 ? c[0][0] : null;
}

/** Час публикации → человеческий слот. Сетка из references/algorithm.md. */
function slotOf(hour) {
  if (hour === null) return '';
  if (hour < 6) return 'ночь (0–6)';
  if (hour < 11) return 'утро (6–11)';
  if (hour < 15) return 'день (11–15)';
  if (hour < 19) return 'вечер (15–19)';
  return 'поздний вечер (19–24)';
}

function parseDate(raw) {
  if (!raw) return { date: '', hour: null, weekday: '' };
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) {
    const hour = m[4] === undefined ? null : Number(m[4]);
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return {
      date: `${m[1]}-${m[2]}-${m[3]}`,
      hour: Number.isFinite(hour) ? hour : null,
      weekday: WEEKDAYS[d.getUTCDay()],
    };
  }
  // Формат ДД.ММ.ГГГГ — так пишут руками чаще всего.
  const r = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (r) {
    const hour = r[4] === undefined ? null : Number(r[4]);
    const d = new Date(Date.UTC(Number(r[3]), Number(r[2]) - 1, Number(r[1])));
    return {
      date: `${r[3]}-${String(r[2]).padStart(2, '0')}-${String(r[1]).padStart(2, '0')}`,
      hour: Number.isFinite(hour) ? hour : null,
      weekday: WEEKDAYS[d.getUTCDay()],
    };
  }
  return { date: s, hour: null, weekday: '' };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function r1(n) {
  return Math.round(n * 10) / 10;
}

/* ------------------------------------------------------------- разбор ---- */

function parseTracker(text, source) {
  const lines = text.split(/\r?\n/)
    .map(l => l.replace(/﻿/g, '').trim())
    .filter(l => l && !l.startsWith('#'));
  if (!lines.length) fail(`файл пуст: ${source}`);

  const delim = guessDelimiter(lines[0]);
  if (!delim) {
    fail('в первой строке нет ни запятой, ни точки с запятой, ни табуляции — это не похоже на CSV.',
      `Файл: ${source}\nОжидается шапка вида:\n  дата,пост,формула,тема,охват,комментарии,заявки`);
  }

  const rawHeaders = splitDelimited(lines[0], delim);
  const headers = rawHeaders.map(columnKey);
  const unknown = rawHeaders.filter((h, i) => h && !headers[i]);

  const present = new Set(headers.filter(Boolean));
  const metricsPresent = METRIC_ORDER.filter(m => present.has(m));
  if (!metricsPresent.length) {
    fail('в шапке нет ни одной колонки с результатом.',
      `Файл: ${source}\nШапка прочитана как: ${rawHeaders.join(' | ')}\n` +
      'Нужна хотя бы одна из: охват, комментарии, переходы_в_личку, диагностики, заявки\n' +
      (unknown.length ? `Не распознаны колонки: ${unknown.join(', ')}\n` : ''));
  }

  const rows = [];
  const emptyRows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitDelimited(lines[i], delim);
    const row = { _line: i + 1 };
    headers.forEach((key, idx) => {
      if (!key) return;
      const v = cells[idx];
      if (METRIC_ORDER.includes(key)) row[key] = num(v);
      else row[key] = v || '';
    });
    const d = parseDate(row.date);
    row.date = d.date;
    // Явная колонка часа в трекере важнее, чем время внутри даты.
    const explicitHour = row.time ? num(row.time) : null;
    row.hour = explicitHour !== null && explicitHour >= 0 && explicitHour <= 23
      ? explicitHour : d.hour;
    row.slot = slotOf(row.hour);
    if (!row.weekday) row.weekday = d.weekday;

    // Строка без единой цифры результата — ещё не заполнена, её не считаем.
    if (METRIC_ORDER.every(m => row[m] === null || row[m] === undefined)) {
      emptyRows.push(i + 1);
      continue;
    }
    rows.push(row);
  }
  return { rows, emptyRows, metricsPresent, unknown, delim, rawHeaders };
}

/* ------------------------------------------------------------- анализ ---- */

/** Группировка по одному признаку. Возвращает срезы с медианой метрики. */
function groupBy(rows, field, metric) {
  const map = new Map();
  for (const r of rows) {
    const k = r[field];
    if (!k) continue;
    const v = r[metric];
    if (v === null || v === undefined) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }
  return [...map.entries()]
    .map(([key, vals]) => ({
      key, n: vals.length, med: median(vals),
      min: Math.min(...vals), max: Math.max(...vals),
    }))
    .sort((a, b) => b.med - a.med);
}

/** Связки «формула × тема» и «формула × время»: то, ради чего скрипт и нужен. */
function combos(rows, metric, minPair) {
  const build = (fa, fb) => {
    const map = new Map();
    for (const r of rows) {
      if (!r[fa] || !r[fb]) continue;
      const v = r[metric];
      if (v === null || v === undefined) continue;
      const k = `${r[fa]} × ${r[fb]}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(v);
    }
    return [...map.entries()]
      .map(([key, vals]) => ({ key, n: vals.length, med: median(vals) }))
      .sort((a, b) => b.med - a.med);
  };
  return {
    formulaTopic: build('formula', 'topic'),
    formulaSlot: build('formula', 'slot'),
    formulaTopicSlot: (() => {
      const map = new Map();
      for (const r of rows) {
        if (!r.formula || !r.topic || !r.slot) continue;
        const v = r[metric];
        if (v === null || v === undefined) continue;
        const k = `${r.formula} × ${r.topic} × ${r.slot}`;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(v);
      }
      return [...map.entries()]
        .map(([key, vals]) => ({ key, n: vals.length, med: median(vals) }))
        .sort((a, b) => b.med - a.med);
    })(),
    minPair,
  };
}

function analyze(rows, metric, minRows) {
  const vals = rows.map(r => r[metric]).filter(v => v !== null && v !== undefined);
  const med = median(vals);
  const fields = ['formula', 'topic', 'lang', 'slot', 'weekday'];
  const groups = {};
  for (const f of fields) {
    const g = groupBy(rows, f, metric);
    if (g.length) groups[f] = g;
  }
  const cmb = combos(rows, metric, MIN_PAIR);

  // Лучшая связка называется ТОЛЬКО если данных достаточно и в самой
  // связке не меньше MIN_PAIR постов. Иначе это наблюдение, не вывод.
  const enough = rows.length >= minRows;
  const pickBest = list => list.find(x => x.n >= MIN_PAIR) || null;
  const best = enough ? {
    formulaTopic: pickBest(cmb.formulaTopic),
    formulaSlot: pickBest(cmb.formulaSlot),
    triple: pickBest(cmb.formulaTopicSlot),
  } : { formulaTopic: null, formulaSlot: null, triple: null };

  return {
    metric, count: rows.length, median: med,
    min: vals.length ? Math.min(...vals) : 0,
    max: vals.length ? Math.max(...vals) : 0,
    sum: vals.reduce((a, b) => a + b, 0),
    groups, combos: cmb, best, enough, minRows,
  };
}

/* -------------------------------------------------------------- вывод ---- */

function pad(s, w) {
  const c = [...String(s)];
  return c.length > w ? c.slice(0, Math.max(1, w - 1)).join('') + '…' : String(s) + ' '.repeat(w - c.length);
}
function padL(s, w) {
  const c = [...String(s)];
  return c.length > w ? c.slice(0, w).join('') : ' '.repeat(w - c.length) + String(s);
}

function printGroups(a) {
  const label = METRIC_RU[a.metric] || a.metric;
  for (const [field, list] of Object.entries(a.groups)) {
    if (list.length < 2) continue;
    console.log(`\n  ${(FIELD_RU[field] || field).toUpperCase()} (медиана «${label}»):`);
    for (const g of list) {
      const thin = g.n < MIN_GROUP ? '  ← мало постов, не сравниваем' : '';
      console.log(`    ${pad(g.key, 30)} ${padL(r1(g.med), 8)}  (${plural(g.n, 'пост', 'поста', 'постов')}, от ${g.min} до ${g.max})${thin}`);
    }
    const solid = list.filter(g => g.n >= MIN_GROUP);
    if (solid.length >= 2 && a.enough) {
      const top = solid[0], bottom = solid[solid.length - 1];
      if (bottom.med > 0) {
        const times = r1(top.med / bottom.med);
        if (times >= 1.5) {
          console.log(`    → «${top.key}» в ${times} раза выше, чем «${bottom.key}» (обе группы от ${MIN_GROUP} постов).`);
        }
      }
    } else if (solid.length < 2) {
      console.log(`    → сравнивать нечего: групп от ${MIN_GROUP} постов меньше двух.`);
    }
  }
}

function printCombos(a) {
  const label = METRIC_RU[a.metric] || a.metric;
  const show = (title, list) => {
    const solid = list.filter(x => x.n >= MIN_PAIR);
    const pool = solid.length ? solid : list;
    if (!pool.length) return;
    console.log(`\n  ${title} (медиана «${label}»):`);
    pool.slice(0, 5).forEach((x, i) => {
      const thin = x.n < MIN_PAIR ? '  ← наблюдение, не вывод' : '';
      console.log(`    ${i + 1}. ${pad(x.key, 44)} ${padL(r1(x.med), 8)}  (${plural(x.n, 'пост', 'поста', 'постов')})${thin}`);
    });
  };
  show('СВЯЗКА ФОРМУЛА × ТЕМА', a.combos.formulaTopic);
  show('СВЯЗКА ФОРМУЛА × ВРЕМЯ', a.combos.formulaSlot);
  show('СВЯЗКА ФОРМУЛА × ТЕМА × ВРЕМЯ', a.combos.formulaTopicSlot);
}

function printVerdict(a) {
  const label = METRIC_RU[a.metric] || a.metric;
  console.log('\n=== ВЫВОД ===\n');
  if (!a.enough) {
    console.log(`  ⚠️ ДАННЫХ МАЛО: ${plural(a.count, 'строка', 'строки', 'строк')} при пороге ${a.minRows}.`);
    console.log('  Лучшую связку не называю — на таком объёме разница между формулами');
    console.log('  укладывается в случайность. Всё выше читать как «что случилось»,');
    console.log('  а не «что работает».');
    console.log(`\n  Что делать: опубликовать ещё ${plural(Math.max(0, a.minRows - a.count), 'пост', 'поста', 'постов')} с заполненным трекером`);
    console.log('  и запустить этот же разбор снова.');
    return;
  }
  const t = a.best.triple, ft = a.best.formulaTopic, fs = a.best.formulaSlot;
  if (t) {
    console.log(`  Лучшая связка по «${label}»: ${t.key}`);
    console.log(`  медиана ${r1(t.med)} на ${plural(t.n, 'посте', 'постах', 'постах')}.`);
  } else if (ft) {
    console.log(`  Лучшая связка формула × тема по «${label}»: ${ft.key}`);
    console.log(`  медиана ${r1(ft.med)} на ${plural(ft.n, 'посте', 'постах', 'постах')}.`);
    console.log(`  Тройную связку с временем не называю: ни одна не набрала ${MIN_PAIR} постов.`);
  } else if (fs) {
    console.log(`  Лучшая связка формула × время по «${label}»: ${fs.key}`);
    console.log(`  медиана ${r1(fs.med)} на ${plural(fs.n, 'посте', 'постах', 'постах')}.`);
  } else {
    console.log(`  Строк хватает (${a.count}), но ни одна связка не набрала ${MIN_PAIR} постов.`);
    console.log('  Причина обычно одна: формулы и темы в трекере не размечены');
    console.log('  или каждый пост помечен по-своему. Сведите пометки к общему списку.');
  }
  console.log(`\n  Медиана «${label}» по всем постам: ${r1(a.median)} (от ${a.min} до ${a.max}).`);
  console.log('  Сравнивать новый пост стоит с медианой, а не со средним:');
  console.log('  один залетевший пост тянет среднее и создаёт ложную картину.');
}

function mdReport(a, source, warnings) {
  const label = METRIC_RU[a.metric] || a.metric;
  const L = [];
  L.push('# Разбор трекера публикаций');
  L.push('');
  L.push(`Источник: \`${source}\`. Метрика: **${label}**. Разобрано ${new Date().toISOString().slice(0, 10)}.`);
  L.push('');
  L.push(`Постов в расчёте: ${a.count}. Медиана: ${r1(a.median)} (от ${a.min} до ${a.max}).`);
  L.push('');
  if (warnings.length) {
    warnings.forEach(w => L.push(`> ${w}`));
    L.push('');
  }
  if (!a.enough) {
    L.push('## ⚠️ Данных мало');
    L.push('');
    L.push(`Строк ${a.count}, порог ${a.minRows}. Лучшая связка НЕ называется намеренно:`);
    L.push('на таком объёме разница между формулами укладывается в случайность.');
    L.push('Таблицы ниже — описание того, что случилось, а не вывод о том, что работает.');
    L.push('');
  }
  for (const [field, list] of Object.entries(a.groups)) {
    if (list.length < 2) continue;
    L.push(`## ${FIELD_RU[field] || field}`);
    L.push('');
    L.push(`| значение | медиана ${label} | постов | разброс |`);
    L.push('|---|---:|---:|---|');
    for (const g of list) {
      const mark = g.n < MIN_GROUP ? ' ⚠️' : '';
      L.push(`| ${g.key}${mark} | ${r1(g.med)} | ${g.n} | ${g.min}–${g.max} |`);
    }
    L.push('');
  }
  const combo = (title, list) => {
    const pool = list.filter(x => x.n >= MIN_PAIR);
    const use = pool.length ? pool : list.slice(0, 5);
    if (!use.length) return;
    L.push(`## ${title}`);
    L.push('');
    L.push(`| связка | медиана ${label} | постов |`);
    L.push('|---|---:|---:|');
    use.slice(0, 8).forEach(x => {
      const mark = x.n < MIN_PAIR ? ' ⚠️ наблюдение' : '';
      L.push(`| ${x.key}${mark} | ${r1(x.med)} | ${x.n} |`);
    });
    L.push('');
  };
  combo('Формула × тема', a.combos.formulaTopic);
  combo('Формула × время публикации', a.combos.formulaSlot);
  combo('Формула × тема × время', a.combos.formulaTopicSlot);

  L.push('## Вывод');
  L.push('');
  if (!a.enough) {
    L.push(`Вывода нет: данных ${a.count} строк при пороге ${a.minRows}.`);
    L.push(`Опубликовать ещё ${Math.max(0, a.minRows - a.count)} постов и повторить разбор.`);
  } else if (a.best.triple) {
    L.push(`Лучшая связка по «${label}»: **${a.best.triple.key}**, медиана ${r1(a.best.triple.med)} на ${a.best.triple.n} постах.`);
  } else if (a.best.formulaTopic) {
    L.push(`Лучшая связка формула × тема: **${a.best.formulaTopic.key}**, медиана ${r1(a.best.formulaTopic.med)} на ${a.best.formulaTopic.n} постах.`);
    L.push('');
    L.push(`Тройная связка с временем не называется: ни одна не набрала ${MIN_PAIR} постов.`);
  } else {
    L.push(`Строк хватает, но ни одна связка не набрала ${MIN_PAIR} постов — размечайте формулу и тему одинаково.`);
  }
  L.push('');
  L.push('Сравнивать новый пост нужно с медианой, а не со средним: один залетевший');
  L.push('пост тянет среднее и создаёт ложную картину роста.');
  L.push('');
  return L.join('\n');
}

/* --------------------------------------------------------------- main ---- */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); process.exit(0); }

  const asJson = argv.includes('--json');
  const takeVal = flag => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) fail(`после ${flag} нужно значение.`);
    return v;
  };
  const mdPath = takeVal('--md');
  const metricArg = takeVal('--metric');
  const minArg = takeVal('--min');

  let minRows = MIN_ROWS;
  if (minArg !== null) {
    const m = Number(minArg);
    if (!Number.isFinite(m) || m < 1) fail(`--min должно быть числом больше 0, а не «${minArg}».`);
    minRows = m;
  }

  const valueFlags = new Set(['--md', '--metric', '--min']);
  const files = argv.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && valueFlags.has(argv[i - 1])));
  if (!files.length) {
    console.error('\nОШИБКА: не указан файл трекера.');
    console.error('\nЗапуск: node lib/stats.mjs generated/tracker.csv');
    console.error(HELP);
    process.exit(2);
  }
  if (files.length > 1) fail(`указано ${files.length} файлов, а скрипт разбирает один трекер.`);

  const file = files[0];
  if (!existsSync(file)) {
    fail(`файл трекера не найден: ${file}`,
      'Проверьте путь. Обычно трекер лежит в generated/tracker.csv');
  }
  const text = readFileSync(file, 'utf8');
  const parsed = parseTracker(text, file);
  const { rows, emptyRows, metricsPresent, unknown } = parsed;

  if (!rows.length) {
    console.error(`\nНЕТ ДАННЫХ. Шапка в ${file} прочитана, но ни одной заполненной строки нет.`);
    if (emptyRows.length) {
      console.error(`Строк без цифр результата: ${emptyRows.length} (номера: ${emptyRows.slice(0, 10).join(', ')}${emptyRows.length > 10 ? '…' : ''}).`);
    }
    console.error('\nТрекер заполняется после публикации: в строку вносятся охват');
    console.error('и комментарии. Пока цифр нет, считать нечего — это нормально');
    console.error('для только что созданного трекера.');
    console.error('\nПодсказка: node lib/stats.mjs --help\n');
    process.exit(1);
  }

  // Какую колонку считать результатом.
  let metric;
  if (metricArg) {
    metric = columnKey(metricArg);
    if (!metric || !METRIC_ORDER.includes(metric)) {
      fail(`неизвестная метрика «${metricArg}».`,
        `Доступны: ${METRIC_ORDER.map(m => METRIC_RU[m]).join(', ')}.\n` +
        `В вашем файле есть: ${metricsPresent.map(m => METRIC_RU[m]).join(', ')}`);
    }
    if (!metricsPresent.includes(metric)) {
      fail(`колонки «${metricArg}» в этом трекере нет.`,
        `Есть: ${metricsPresent.map(m => METRIC_RU[m]).join(', ')}`);
    }
  } else {
    // Берём первую по приоритету метрику, в которой ЕСТЬ заполненные цифры:
    // колонка может присутствовать в шапке, но быть пустой во всех строках.
    metric = METRIC_ORDER.find(m => metricsPresent.includes(m)
      && rows.some(r => r[m] !== null && r[m] !== undefined)) || metricsPresent[0];
  }

  const a = analyze(rows, metric, minRows);

  const warnings = [];
  if (emptyRows.length) {
    warnings.push(`Строк без цифр результата пропущено: ${emptyRows.length} (номера: ${emptyRows.slice(0, 8).join(', ')}${emptyRows.length > 8 ? '…' : ''}). Обычно это ещё не заполненные публикации.`);
  }
  if (unknown.length) {
    warnings.push(`Колонки, которые скрипт не понял и пропустил: ${unknown.join(', ')}.`);
  }
  if (!rows.some(r => r.slot)) {
    warnings.push('Времени публикации в трекере нет — срез по времени не построен. Добавьте в колонку даты часы: 2026-09-01 09:12.');
  }
  if (!rows.some(r => r.formula)) {
    warnings.push('Колонка «формула» пуста — связки «формула × тема» посчитать нельзя.');
  }

  if (asJson) {
    console.log(JSON.stringify({
      ok: true, source: file, metric, metricRu: METRIC_RU[metric],
      count: a.count, median: a.median, min: a.min, max: a.max,
      enoughData: a.enough, minRows: a.minRows,
      thresholds: { minRows: a.minRows, minGroup: MIN_GROUP, minPair: MIN_PAIR },
      groups: a.groups, combos: {
        formulaTopic: a.combos.formulaTopic,
        formulaSlot: a.combos.formulaSlot,
        formulaTopicSlot: a.combos.formulaTopicSlot,
      },
      best: a.best, warnings,
    }, null, 2));
  } else {
    console.log(`\nТрекер: ${file}`);
    console.log(`Метрика для сравнения: ${METRIC_RU[metric]}${metricArg ? ' (выбрана вами)' : ' (выбрана автоматически, сменить: --metric комментарии)'}`);
    console.log(`Строк с данными: ${a.count}. Доступные метрики: ${metricsPresent.map(m => METRIC_RU[m]).join(', ')}`);
    if (warnings.length) {
      console.log('\nЗАМЕЧАНИЯ ПО ФАЙЛУ:');
      warnings.forEach(w => console.log(`  ! ${w}`));
    }
    console.log('\n=== СРЕЗЫ ===');
    printGroups(a);
    printCombos(a);
    printVerdict(a);
    console.log();
  }

  if (mdPath) {
    try {
      writeFileSync(mdPath, mdReport(a, file, warnings), 'utf8');
      if (!asJson) console.log(`Отчёт записан: ${mdPath}\n`);
    } catch (e) {
      fail(`не удалось записать отчёт в ${mdPath}: ${e.message}`,
        'Проверьте, что папка существует и есть права на запись.');
    }
  }
  process.exit(0);
}

main();
