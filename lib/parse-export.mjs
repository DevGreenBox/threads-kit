#!/usr/bin/env node
/**
 * Разбор метрик СВОИХ постов, которые вы выгрузили или скопировали сами.
 *
 * ⚠️ ГРАНИЦА, КОТОРУЮ НЕ ПЕРЕСЕКАЕМ
 * Этот скрипт НИКУДА НЕ ХОДИТ: ни в сеть, ни в браузер, ни с логином. Он
 * разбирает только тот файл, который вы ему дали. Ни публикации, ни
 * скрейпинга здесь нет и не будет — поэтому он работает без всякого токена
 * и без заявки в Meta. Цифры можно просто переписать из приложения руками.
 * (Работа с Threads по официальному API — это lib/monitor/, отдельно.)
 *
 * Использование:
 *   node lib/parse-export.mjs insights.json
 *   node lib/parse-export.mjs metrics.csv
 *   node lib/parse-export.mjs вставка.txt --md отчёт.md
 *   cat вставка.txt | node lib/parse-export.mjs
 *
 * Коды возврата: 0 — разобрано, 1 — файл прочитан, но ни одной строки метрик
 *                не распознано, 2 — ошибка запуска (нет файла, битый JSON).
 *
 * ЧТО МОЖНО ПОДАТЬ НА ВХОД
 *
 * 1. JSON официального Threads API (эндпоинт /{media-id}/insights,
 *    метрики views,likes,replies,reposts,quotes). Понимаются все три формы,
 *    в которых Meta отдаёт числа:
 *      {"data":[{"name":"views","period":"lifetime","values":[{"value":1234}]}]}
 *      {"data":[{"name":"views","total_value":{"value":1234}}]}
 *      {"data":[{"id":"...","text":"...","views":1234,"likes":10}]}
 *    Массив таких объектов = несколько постов. Если в JSON есть поля
 *    id / text / permalink / timestamp — они подхватываются как подпись поста.
 *
 * 2. CSV или таблица, вставленная руками (разделитель , ; или таб).
 *    Нужна строка-шапка, названия колонок понимаются и по-русски:
 *      дата,пост,формула,тема,охват,лайки,ответы,репосты,цитаты
 *      date,post,formula,topic,views,likes,replies,reposts,quotes
 *    Хватает двух колонок: чем пост назвать и сколько охвата.
 *
 * 3. Свободная вставка из приложения, построчно:
 *      «Почему 474 товара невидимы — 12500 просмотров, 34 ответа, 8 репостов»
 *    Числа с пометками «просмотр/ответ/лайк/репост/цитата» вытаскиваются
 *    из строки в любом порядке.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const HELP = `
Разбор метрик своих постов Threads. В сеть не ходит: читает только ваш файл.

  node lib/parse-export.mjs <файл>              разобрать и показать таблицу
  node lib/parse-export.mjs <файл> --md <файл>  дополнительно отчёт в markdown
  node lib/parse-export.mjs <файл> --json       результат в JSON
  cat вставка.txt | node lib/parse-export.mjs   разобрать то, что подано на вход
  node lib/parse-export.mjs --help              эта справка

ЧТО ПОДАТЬ НА ВХОД (любое из трёх)

1) JSON официального Threads API — ответ /{media-id}/insights с метриками
   views,likes,replies,reposts,quotes. Понимаются формы values[].value,
   total_value.value и плоская {"views": 1234}.

2) CSV или таблица, вставленная руками. Разделитель запятая, точка с запятой
   или таб. Первая строка — шапка, названия колонок можно по-русски:
     дата,пост,формула,тема,охват,лайки,ответы,репосты,цитаты
   Минимум, который нужен: чем пост назвать + колонка охвата.

3) Свободная вставка построчно, числа с пометками:
     Почему 474 товара невидимы — 12500 просмотров, 34 ответа, 8 репостов

ГДЕ ВЗЯТЬ ДАННЫЕ
  В приложении Threads: свой профиль → Статистика (Insights) → пост.
  Цифры переписываются или копируются руками. Автосбора нет намеренно:
  официального API для чтения чужих веток не существует, а обходить защиту
  площадки этот набор инструментов не будет.

КОДЫ ВОЗВРАТА
  0  разобрано
  1  файл прочитан, но ни одной строки метрик не распознано
  2  ошибка запуска (файла нет, JSON битый)
`;

function fail(msg, hint) {
  console.error(`\nОШИБКА: ${msg}`);
  if (hint) console.error(hint);
  console.error('\nПодсказка: node lib/parse-export.mjs --help\n');
  process.exit(2);
}

const METRIC_KEYS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares', 'clicks'];

// Синонимы колонок: русские и английские названия к одному ключу.
const COLUMN_MAP = {
  views: ['views', 'view', 'охват', 'просмотры', 'просмотров', 'показы', 'impressions', 'reach'],
  likes: ['likes', 'like', 'лайки', 'лайков', 'нравится'],
  replies: ['replies', 'reply', 'comments', 'ответы', 'ответов', 'комментарии', 'комменты'],
  reposts: ['reposts', 'repost', 'репосты', 'репостов', 'ретвиты'],
  quotes: ['quotes', 'quote', 'цитаты', 'цитат', 'цитирования'],
  shares: ['shares', 'share', 'поделились'],
  clicks: ['clicks', 'link_clicks', 'переходы', 'клики'],
  post: ['post', 'text', 'название', 'пост', 'заголовок', 'title', 'crop', 'permalink'],
  date: ['date', 'timestamp', 'дата', 'время', 'опубликован'],
  formula: ['formula', 'формула', 'хук', 'hook'],
  topic: ['topic', 'тема', 'theme'],
  lang: ['lang', 'language', 'язык'],
  time: ['time', 'час', 'время_публикации', 'hour'],
};

function columnKey(header) {
  const h = String(header).trim().toLowerCase().replace(/^["']|["']$/g, '');
  for (const [key, names] of Object.entries(COLUMN_MAP)) {
    if (names.includes(h)) return key;
  }
  return null;
}

function num(v) {
  if (v === undefined || v === null || v === '') return 0;
  // «12 500», «12,500», «1.2K» — приводим к числу.
  const s = String(v).trim().replace(/[\s\u00a0\u202f]/g, '');
  const km = s.match(/^([\d.,]+)\s*([kKкКmMмМ])$/);
  if (km) {
    const base = Number(km[1].replace(',', '.'));
    const mult = /[kKкК]/.test(km[2]) ? 1000 : 1000000;
    return Number.isFinite(base) ? Math.round(base * mult) : 0;
  }
  const n = Number(s.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

/** Русское согласование: 1 пост, 2 поста, 5 постов. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return `${n} ${many}`;
  if (b > 1 && b < 5) return `${n} ${few}`;
  if (b === 1) return `${n} ${one}`;
  return `${n} ${many}`;
}

function emptyPost(label) {
  return {
    post: label, date: '', formula: '', topic: '', lang: '', time: '',
    views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, shares: 0, clicks: 0,
  };
}

/* ---------------------------------------------------------------- JSON ---- */

/** Достаёт число из любой из трёх форм, в которых Meta отдаёт метрику. */
function metricValue(entry) {
  if (entry && entry.total_value && entry.total_value.value !== undefined) {
    return num(entry.total_value.value);
  }
  if (Array.isArray(entry?.values)) {
    // views отдаётся дневными срезами — суммируем их.
    return entry.values.reduce((s, v) => s + num(v?.value), 0);
  }
  if (entry?.value !== undefined) return num(entry.value);
  return 0;
}

/** Один объект insights ({data:[{name,values}]}) → один пост. */
function fromInsightsBlock(block, label) {
  const row = emptyPost(label);
  const arr = Array.isArray(block?.data) ? block.data : Array.isArray(block) ? block : [];
  let found = 0;
  for (const entry of arr) {
    const name = String(entry?.name || '').toLowerCase();
    if (!name) continue;
    const key = columnKey(name);
    if (key && METRIC_KEYS.includes(key)) {
      row[key] = metricValue(entry);
      found++;
    }
  }
  return found ? row : null;
}

/** Плоский объект поста: {id, text, views, likes, ...} или с вложенным insights. */
function fromFlatObject(obj, idx) {
  const label = String(obj.text || obj.post || obj.caption || obj.permalink || obj.id || `пост ${idx + 1}`)
    .replace(/\s+/g, ' ').trim();
  const row = emptyPost(label || `пост ${idx + 1}`);
  if (obj.timestamp || obj.date) row.date = String(obj.timestamp || obj.date).slice(0, 16);
  if (obj.formula) row.formula = String(obj.formula);
  if (obj.topic) row.topic = String(obj.topic);
  if (obj.lang || obj.language) row.lang = String(obj.lang || obj.language);
  if (obj.permalink && !obj.text && !obj.post) row.link = obj.permalink;

  let found = 0;
  // Вложенный блок insights внутри объекта поста.
  const nested = obj.insights?.data || obj.insights;
  if (Array.isArray(nested)) {
    const sub = fromInsightsBlock({ data: nested }, row.post);
    if (sub) {
      for (const k of METRIC_KEYS) if (sub[k]) { row[k] = sub[k]; found++; }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = columnKey(k);
    if (key && METRIC_KEYS.includes(key) && typeof v !== 'object') {
      row[key] = num(v);
      found++;
    }
  }
  return found ? row : null;
}

function parseJson(text, source) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    fail(`это похоже на JSON, но разобрать не удалось: ${e.message}`,
      `Файл: ${source}\nОткройте его и проверьте, что скопирован весь ответ целиком, включая внешние { }.`);
  }
  const rows = [];
  const list = Array.isArray(data) ? data
    : Array.isArray(data.data) && data.data.some(d => d?.name && (d.values || d.total_value)) ? [data]
      : Array.isArray(data.data) ? data.data
        : [data];

  list.forEach((item, idx) => {
    if (!item || typeof item !== 'object') return;
    // Сначала форма insights (name/values), затем плоская.
    const asInsights = (Array.isArray(item.data) || (item.name && (item.values || item.total_value)))
      ? fromInsightsBlock(Array.isArray(item.data) ? item : { data: list }, String(item.id || `пост ${idx + 1}`))
      : null;
    const row = asInsights || fromFlatObject(item, idx);
    if (row) rows.push(row);
  });

  // Особый случай: {"data":[{"name":"views",...},{"name":"likes",...}]} —
  // это ОДИН пост, разложенный по метрикам, а не список постов.
  if (!Array.isArray(data) && Array.isArray(data.data) &&
      data.data.every(d => d?.name) && rows.length > 1) {
    const single = fromInsightsBlock(data, String(data.id || 'пост 1'));
    return single ? [single] : rows;
  }
  return rows;
}

/* ----------------------------------------------------------------- CSV ---- */

function splitDelimited(line, delim) {
  // Минимальный разбор с кавычками: поля вида "текст, с запятой".
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; }
      else q = !q;
    } else if (ch === delim && !q) {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function guessDelimiter(line) {
  const counts = [['\t', (line.match(/\t/g) || []).length],
    [';', (line.match(/;/g) || []).length],
    [',', (line.match(/,/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : null;
}

function parseCsv(lines) {
  const delim = guessDelimiter(lines[0]);
  if (!delim) return null;
  const headers = splitDelimited(lines[0], delim).map(columnKey);
  // Шапка считается шапкой, если узнано хотя бы 2 колонки и есть метрика.
  const known = headers.filter(Boolean);
  if (known.length < 2 || !known.some(k => METRIC_KEYS.includes(k))) return null;

  const rows = [];
  const skipped = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitDelimited(lines[i], delim);
    if (cells.every(c => !c)) continue;
    const row = emptyPost('');
    headers.forEach((key, idx) => {
      if (!key) return;
      const v = cells[idx];
      if (METRIC_KEYS.includes(key)) row[key] = num(v);
      else row[key] = (v || '').replace(/^["']|["']$/g, '');
    });
    if (!row.post) row.post = row.date || `строка ${i + 1}`;
    if (METRIC_KEYS.every(k => !row[k])) { skipped.push(i + 1); continue; }
    rows.push(row);
  }
  return { rows, skipped, delim, headers };
}

/* ----------------------------------------------- свободная вставка ------- */

const NUM = '(\\d[\\d\\s\\u00a0.,]*(?:\\s*[kKкКmMмМ])?)';
const LOOSE = [
  ['views', new RegExp(NUM + '\\s*(просмотр\\w*|показ\\w*|views?|impressions?)', 'i')],
  ['likes', new RegExp(NUM + '\\s*(лайк\\w*|likes?)', 'i')],
  ['replies', new RegExp(NUM + '\\s*(ответ\\w*|комментар\\w*|replies|reply|comments?)', 'i')],
  ['reposts', new RegExp(NUM + '\\s*(репост\\w*|reposts?)', 'i')],
  ['quotes', new RegExp(NUM + '\\s*(цитат\\w*|quotes?)', 'i')],
];

function parseLoose(lines) {
  const rows = [];
  const skipped = [];
  lines.forEach((line, i) => {
    const row = emptyPost('');
    let found = 0;
    let cut = line.length;
    for (const [key, re] of LOOSE) {
      const m = line.match(re);
      if (m) {
        row[key] = num(m[1]);
        found++;
        cut = Math.min(cut, m.index);
      }
    }
    if (!found) { skipped.push(i + 1); return; }
    row.post = line.slice(0, cut).replace(/[\s—–\-:,]+$/, '').trim() || `строка ${i + 1}`;
    rows.push(row);
  });
  return { rows, skipped };
}

/* -------------------------------------------------------------- вывод ---- */

function derive(row) {
  const engagement = row.likes + row.replies + row.reposts + row.quotes;
  const er = row.views > 0 ? (engagement / row.views) * 100 : 0;
  // Реплаи весят больше всего, репост заменяет закладку. Вес по algorithm.md.
  const weighted = row.replies * 3 + row.reposts * 2 + row.quotes * 2 + row.likes * 0.2;
  const rr = row.views > 0 ? (row.replies / row.views) * 100 : 0;
  return { ...row, engagement, er, weighted, rr };
}

function pad(s, w) {
  s = String(s);
  // Кириллица в моно-шрифте занимает одну ячейку, считаем по символам.
  const chars = [...s];
  if (chars.length > w) return chars.slice(0, Math.max(1, w - 1)).join('') + '…';
  return s + ' '.repeat(w - chars.length);
}
function padL(s, w) {
  s = String(s);
  const chars = [...s];
  if (chars.length > w) return chars.slice(0, w).join('');
  return ' '.repeat(w - chars.length) + s;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function printTable(rows) {
  const W = 44;
  console.log('\n=== МЕТРИКИ ПОСТОВ ===\n');
  console.log(`  ${pad('пост', W)} ${padL('охват', 8)} ${padL('отв', 5)} ${padL('реп', 5)} ${padL('лайк', 5)} ${padL('ER%', 6)} ${padL('вес', 7)}`);
  console.log(`  ${'─'.repeat(W)} ${'─'.repeat(8)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(5)} ${'─'.repeat(6)} ${'─'.repeat(7)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.post, W)} ${padL(r.views, 8)} ${padL(r.replies, 5)} ${padL(r.reposts, 5)} ${padL(r.likes, 5)} ${padL(r.er.toFixed(1), 6)} ${padL(r.weighted.toFixed(1), 7)}`);
  }
}

function summary(rows) {
  const byViews = [...rows].sort((a, b) => b.views - a.views);
  const byReplies = [...rows].sort((a, b) => b.replies - a.replies);
  const byWeighted = [...rows].sort((a, b) => b.weighted - a.weighted);
  const medViews = median(rows.map(r => r.views));
  const medReplies = median(rows.map(r => r.replies));

  const lines = [];
  lines.push(`разобрано: ${plural(rows.length, 'пост', 'поста', 'постов')}`);
  lines.push(`медиана охвата: ${Math.round(medViews)}; медиана ответов: ${medReplies}`);
  lines.push(`сумма охвата: ${rows.reduce((s, r) => s + r.views, 0)}; ответов: ${rows.reduce((s, r) => s + r.replies, 0)}`);

  const groups = [];
  // Формула / тема считаются только если человек их указал в данных.
  for (const field of ['formula', 'topic', 'lang']) {
    const named = rows.filter(r => r[field]);
    if (named.length < 2) continue;
    const map = new Map();
    for (const r of named) {
      const g = map.get(r[field]) || { n: 0, views: [], replies: [] };
      g.n++; g.views.push(r.views); g.replies.push(r.replies);
      map.set(r[field], g);
    }
    if (map.size < 2) continue;
    const ranked = [...map.entries()]
      .map(([k, g]) => ({ k, n: g.n, medViews: median(g.views), medReplies: median(g.replies) }))
      .sort((a, b) => b.medViews - a.medViews);
    groups.push({ field, ranked });
  }

  return { byViews, byReplies, byWeighted, medViews, medReplies, lines, groups };
}

const FIELD_RU = { formula: 'формула', topic: 'тема', lang: 'язык' };

function printSummary(rows, s) {
  console.log('\n=== СВОДКА ===\n');
  s.lines.forEach(l => console.log(`  · ${l}`));

  console.log('\n  ОХВАТ (кого раздали шире):');
  s.byViews.slice(0, 3).forEach((r, i) => {
    const mark = r.views >= s.medViews ? 'выше медианы' : 'ниже медианы';
    console.log(`   ${i + 1}. ${r.views} — ${r.post} (${mark})`);
  });

  console.log('\n  ОТВЕТЫ (самый весомый сигнал алгоритма):');
  const withReplies = s.byReplies.filter(r => r.replies > 0);
  if (!withReplies.length) {
    console.log('   — ни одного ответа. Охват без ответов второй волны не даёт: посты не заточены под разговор.');
  } else {
    withReplies.slice(0, 3).forEach((r, i) => {
      console.log(`   ${i + 1}. ${r.replies} отв. при ${r.views} охвата (${r.rr.toFixed(2)}% отвечаемость) — ${r.post}`);
    });
  }

  console.log('\n  ПО ВЗВЕШЕННОМУ СИГНАЛУ (ответ×3, репост и цитата×2, лайк×0.2):');
  s.byWeighted.slice(0, 3).forEach((r, i) => {
    console.log(`   ${i + 1}. ${r.weighted.toFixed(1)} — ${r.post}`);
  });

  if (s.groups.length) {
    console.log('\n  ЧТО СРАБОТАЛО (по вашим пометкам в данных):');
    for (const g of s.groups) {
      console.log(`   ${FIELD_RU[g.field] || g.field}:`);
      g.ranked.forEach(r => {
        console.log(`     · ${r.k}: медиана охвата ${Math.round(r.medViews)}, ответов ${r.medReplies} (${plural(r.n, 'пост', 'поста', 'постов')})`);
      });
      const top = g.ranked[0];
      if (top.n < 3) {
        console.log(`     ⚠️ у лидера «${top.k}» всего ${plural(top.n, 'пост', 'поста', 'постов')} — это ещё не вывод, а наблюдение.`);
      }
    }
  } else {
    console.log('\n  ЧТО СРАБОТАЛО: формулы и темы не размечены.');
    console.log('   Добавьте в данные колонки «формула» и «тема» — тогда скрипт скажет, какая связка даёт охват.');
  }

  if (rows.length === 1) {
    console.log('\n  ⚠️ ЭТО ОДИН ПОСТ. Сравнивать не с чем: ни медианы, ни «что сработало» тут быть не может.');
    console.log('   Цифры выше — просто факт по этому посту.');
  } else if (rows.length < 10) {
    console.log(`\n  ⚠️ ДАННЫХ МАЛО: ${plural(rows.length, 'пост', 'поста', 'постов')}. Это описание фактов, а не вывод о закономерности.`);
    console.log('   Надёжные связки видны примерно с 10 постов на формулу.');
  }
  console.log();
}

function mdReport(rows, s, source) {
  const L = [];
  L.push('# Разбор метрик постов Threads');
  L.push('');
  L.push(`Источник данных: \`${source}\`. Разобрано ${new Date().toISOString().slice(0, 10)}.`);
  L.push('');
  L.push('Цифры взяты из файла, который дал человек. Скрипт в сеть не ходит.');
  L.push('');
  L.push('## Таблица');
  L.push('');
  L.push('| пост | охват | ответы | репосты | цитаты | лайки | ER % | взвеш. сигнал |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    const label = r.post.replace(/\|/g, '\\|');
    L.push(`| ${label} | ${r.views} | ${r.replies} | ${r.reposts} | ${r.quotes} | ${r.likes} | ${r.er.toFixed(1)} | ${r.weighted.toFixed(1)} |`);
  }
  L.push('');
  L.push('## Сводка');
  L.push('');
  s.lines.forEach(l => L.push(`- ${l}`));
  L.push('');
  L.push('## Что дало охват');
  L.push('');
  s.byViews.slice(0, 3).forEach((r, i) => L.push(`${i + 1}. **${r.views}** — ${r.post}`));
  L.push('');
  L.push('## Что дало ответы');
  L.push('');
  const wr = s.byReplies.filter(r => r.replies > 0);
  if (!wr.length) L.push('Ни одного ответа. Посты собирают просмотры, но не разговор.');
  else wr.slice(0, 3).forEach((r, i) => L.push(`${i + 1}. **${r.replies}** отв. (${r.rr.toFixed(2)}% от охвата) — ${r.post}`));
  L.push('');
  if (s.groups.length) {
    L.push('## Какая формула сработала');
    L.push('');
    for (const g of s.groups) {
      L.push(`### ${FIELD_RU[g.field] || g.field}`);
      L.push('');
      L.push('| значение | постов | медиана охвата | медиана ответов |');
      L.push('|---|---:|---:|---:|');
      g.ranked.forEach(r => L.push(`| ${r.k} | ${r.n} | ${Math.round(r.medViews)} | ${r.medReplies} |`));
      L.push('');
    }
  } else {
    L.push('## Какая формула сработала');
    L.push('');
    L.push('Формулы и темы в данных не размечены — связку определить нельзя.');
    L.push('Добавьте колонки «формула» и «тема».');
    L.push('');
  }
  L.push('## Честная оговорка');
  L.push('');
  if (rows.length === 1) {
    L.push('В данных один пост. Медиана и сравнение формул тут смысла не имеют —');
    L.push('это просто факт по одному посту.');
  } else if (rows.length < 10) {
    L.push(`В данных ${plural(rows.length, 'пост', 'поста', 'постов')}, это меньше 10. Всё выше — описание того,`);
    L.push('что случилось, а не закономерность. На таком объёме разница между формулами');
    L.push('укладывается в случайность.');
  } else {
    L.push(`В данных ${plural(rows.length, 'пост', 'поста', 'постов')}. Этого хватает, чтобы говорить о тенденции,`);
    L.push('но проверять её стоит на следующей партии постов, а не считать доказанной.');
  }
  L.push('');
  return L.join('\n');
}

/* --------------------------------------------------------------- main ---- */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }
  const asJson = argv.includes('--json');
  const mdIdx = argv.indexOf('--md');
  let mdPath = null;
  if (mdIdx !== -1) {
    mdPath = argv[mdIdx + 1];
    if (!mdPath || mdPath.startsWith('--')) {
      fail('после --md нужен путь, куда записать отчёт.', 'Например: --md отчёт.md');
    }
  }
  const files = argv.filter((a, i) => !a.startsWith('--') && !(mdIdx !== -1 && i === mdIdx + 1));
  if (files.length > 1) {
    fail(`указано ${files.length} файлов, а скрипт разбирает по одному.`);
  }

  const file = files[0];
  let raw;
  if (file) {
    if (!existsSync(file)) {
      fail(`файл не найден: ${file}`,
        'Проверьте путь. Или подайте вставку на вход: cat вставка.txt | node lib/parse-export.mjs');
    }
    raw = readFileSync(file, 'utf8');
  } else {
    if (process.stdin.isTTY) {
      console.error('\nОШИБКА: нечего разбирать — файл не указан, и на вход ничего не подано.');
      console.error(HELP);
      process.exit(2);
    }
    raw = readFileSync(0, 'utf8');
  }
  const source = file || '(вставка со входа)';

  if (!raw.trim()) {
    fail('файл пуст — разбирать нечего.', `Файл: ${source}`);
  }

  let rows = [];
  let kind = '';
  let skipped = [];

  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    rows = parseJson(trimmed, source);
    kind = 'JSON Threads API';
  } else {
    const lines = trimmed.split(/\r?\n/).map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    const csv = lines.length > 1 ? parseCsv(lines) : null;
    if (csv) {
      rows = csv.rows;
      skipped = csv.skipped;
      kind = `таблица (разделитель «${csv.delim === '\t' ? 'таб' : csv.delim}»)`;
    } else {
      const loose = parseLoose(lines);
      rows = loose.rows;
      skipped = loose.skipped;
      kind = 'свободная вставка';
    }
  }

  if (!rows.length) {
    console.error(`\nНИЧЕГО НЕ РАЗОБРАНО. Файл прочитан (${source}), но метрик в нём не найдено.`);
    console.error('\nЧто обычно не так:');
    console.error('  · в таблице нет строки-шапки, или в шапке нет колонки охвата');
    console.error('    (подойдёт любое из: охват, просмотры, views);');
    console.error('  · в свободной вставке числа без пометок — нужно «12500 просмотров», а не просто «12500»;');
    console.error('  · JSON скопирован не целиком.');
    console.error('\nПример строки, которую скрипт понимает:');
    console.error('  Почему 474 товара невидимы — 12500 просмотров, 34 ответа, 8 репостов');
    console.error('\nПодсказка: node lib/parse-export.mjs --help\n');
    process.exit(1);
  }

  const enriched = rows.map(derive);
  const s = summary(enriched);

  if (asJson) {
    console.log(JSON.stringify({
      ok: true, source, kind, count: enriched.length,
      medianViews: s.medViews, medianReplies: s.medReplies,
      lowData: enriched.length < 10,
      posts: enriched,
      groups: s.groups,
    }, null, 2));
  } else {
    console.log(`\nИсточник: ${source}`);
    console.log(`Распознано как: ${kind}`);
    if (skipped.length) {
      console.log(`Пропущено строк без метрик: ${skipped.length} (номера: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? '…' : ''})`);
    }
    printTable(enriched);
    printSummary(enriched, s);
  }

  if (mdPath) {
    try {
      writeFileSync(mdPath, mdReport(enriched, s, source), 'utf8');
      if (!asJson) console.log(`  Отчёт записан: ${mdPath}\n`);
    } catch (e) {
      fail(`не удалось записать отчёт в ${mdPath}: ${e.message}`,
        'Проверьте, что папка существует и есть права на запись.');
    }
  }
  process.exit(0);
}

main();
