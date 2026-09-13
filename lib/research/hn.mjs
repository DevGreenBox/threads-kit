#!/usr/bin/env node
/**
 * hn.mjs — клиент Hacker News: что обсуждают прямо сейчас в тех-нишах.
 *
 * Два независимых API, оба БЕСПЛАТНЫ и БЕЗ КЛЮЧА (проверено живьём 2026-09-13):
 *
 *   1) Официальный Firebase API — https://hacker-news.firebaseio.com/v0/
 *      Источник истины: актуальные топы и полные объекты историй.
 *      Минус: топы отдаются СПИСКОМ ID (до 500), за каждой историей —
 *      отдельный запрос. Отсюда параллельные пачки ниже.
 *      Поиска нет вообще.
 *
 *   2) Algolia Search API — https://hn.algolia.com/api/v1/
 *      Полнотекстовый поиск с фильтрами по дате и очкам, одним запросом.
 *      Неофициальный в смысле «не Y Combinator», но это публичный
 *      задокументированный API самой Algolia для HN, им пользуется веб-поиск
 *      на news.ycombinator.com. Лимит официально не опубликован — отсюда
 *      пауза между запросами и никакого долбления.
 *
 * Зачем скилу: HN — это источник ТЕМЫ («о чём сейчас спорят»), а НЕ источник
 * ФАКТА. Заголовок на HN — это чья-то формулировка, а очки — не подтверждение
 * правды. Факт берётся из статьи, на которую история ссылается, и проверяется
 * до первоисточника (см. lib/research/verify.mjs).
 *
 * Запуск:
 *   node lib/research/hn.mjs top --limit 10 --min-score 100
 *   node lib/research/hn.mjs search "ai agents" --days 7 --min-score 50
 *   node lib/research/hn.mjs search "postgres" --days 30 --limit 5 --json
 *   node lib/research/hn.mjs show --limit 5      # Show HN за неделю
 *   node lib/research/hn.mjs ask  --limit 5      # Ask HN за неделю
 *
 * Ключи не нужны и не используются.
 */

const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA = 'https://hn.algolia.com/api/v1';
const UA = process.env.THREADS_KIT_UA || 'threads-kit-research/1.0 (+contact: set THREADS_KIT_UA)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ссылка на обсуждение — то, что в Threads ценнее самой статьи. */
export const discussionUrl = (id) => `https://news.ycombinator.com/item?id=${id}`;

async function getJson(url, { timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ac.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} на ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Не удалось получить ${url}: ${lastErr?.message || 'неизвестно'}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Официальный Firebase API
// ─────────────────────────────────────────────────────────────────────────────

/** Список ID: 'top' | 'new' | 'best' | 'ask' | 'show' | 'job'. */
export async function fetchStoryIds(kind = 'top') {
  const map = {
    top: 'topstories',
    new: 'newstories',
    best: 'beststories',
    ask: 'askstories',
    show: 'showstories',
    job: 'jobstories',
  };
  const endpoint = map[kind];
  if (!endpoint) throw new Error(`Неизвестный список «${kind}». Доступны: ${Object.keys(map).join(', ')}`);
  const ids = await getJson(`${FIREBASE}/${endpoint}.json`);
  if (!Array.isArray(ids)) throw new Error('HN отдал не массив ID — формат изменился?');
  return ids;
}

export async function fetchItem(id) {
  return getJson(`${FIREBASE}/item/${id}.json`);
}

/**
 * Тянет истории пачками. Параллелить приходится: иначе 100 историй = 100
 * последовательных запросов. Пачка небольшая, чтобы не выглядеть атакой.
 */
export async function fetchItems(ids, { batchSize = 10, delayMs = 120 } = {}) {
  const out = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const got = await Promise.all(
      batch.map((id) => fetchItem(id).catch(() => null))
    );
    out.push(...got.filter(Boolean));
    if (i + batchSize < ids.length) await sleep(delayMs);
  }
  return out;
}

function normalizeFirebase(it) {
  return {
    id: it.id,
    title: it.title || '',
    url: it.url || discussionUrl(it.id), // Ask/Show HN часто без внешней ссылки
    isSelfPost: !it.url,
    score: it.score ?? 0,
    comments: it.descendants ?? 0,
    author: it.by || '',
    createdAt: it.time ? new Date(it.time * 1000).toISOString() : '',
    ageHours: it.time ? Math.round(((Date.now() / 1000 - it.time) / 3600) * 10) / 10 : null,
    discussion: discussionUrl(it.id),
    via: 'firebase',
  };
}

/**
 * Топ HN с фильтрами.
 * @param {object} o
 * @param {string} o.kind    top|new|best|ask|show|job
 * @param {number} o.limit   сколько вернуть
 * @param {number} o.minScore минимум очков
 * @param {number} o.maxAgeHours отсечь старое (0 = не отсекать)
 * @param {number} o.scan    сколько ID просмотреть (топ-500 — весь список)
 */
export async function topStories({
  kind = 'top',
  limit = 10,
  minScore = 0,
  maxAgeHours = 0,
  scan = 60,
} = {}) {
  const ids = await fetchStoryIds(kind);
  const slice = ids.slice(0, Math.max(scan, limit));
  const items = await fetchItems(slice);

  let rows = items
    .filter((it) => it && it.type === 'story' && !it.deleted && !it.dead)
    .map(normalizeFirebase);

  const before = rows.length;
  if (minScore > 0) rows = rows.filter((r) => r.score >= minScore);
  if (maxAgeHours > 0) rows = rows.filter((r) => r.ageHours != null && r.ageHours <= maxAgeHours);

  // Порядок HN уже отражает «горячесть», но после фильтров сортируем по очкам,
  // чтобы наверху оказалось то, что реально обсуждают.
  rows.sort((a, b) => b.score - a.score);

  return {
    kind,
    scanned: slice.length,
    matchedBeforeFilters: before,
    matched: rows.length,
    items: rows.slice(0, limit),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Algolia Search API
// ─────────────────────────────────────────────────────────────────────────────

function normalizeAlgolia(h) {
  const id = Number(h.objectID);
  return {
    id,
    title: h.title || h.story_title || '',
    url: h.url || h.story_url || discussionUrl(id),
    isSelfPost: !(h.url || h.story_url),
    score: h.points ?? 0,
    comments: h.num_comments ?? 0,
    author: h.author || '',
    createdAt: h.created_at || '',
    ageHours: h.created_at_i
      ? Math.round(((Date.now() / 1000 - h.created_at_i) / 3600) * 10) / 10
      : null,
    discussion: discussionUrl(id),
    via: 'algolia',
  };
}

/**
 * Поиск по HN.
 * @param {string} query ключевые слова
 * @param {object} o
 * @param {number} o.days      окно в днях (0 = без ограничения)
 * @param {number} o.minScore  минимум очков
 * @param {number} o.limit     сколько вернуть
 * @param {boolean} o.byDate   true — сортировать по дате, false — по релевантности
 * @param {string} o.tags      теги Algolia: story | show_hn | ask_hn | front_page
 */
export async function search(query, { days = 7, minScore = 0, limit = 20, byDate = false, tags = 'story' } = {}) {
  if (!query || !String(query).trim()) throw new Error('Пустой поисковый запрос.');

  const endpoint = byDate ? 'search_by_date' : 'search';
  const params = new URLSearchParams();
  params.set('query', String(query).trim());
  params.set('tags', tags);
  params.set('hitsPerPage', String(Math.min(Math.max(limit * 3, 20), 100)));

  const filters = [];
  if (days > 0) {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    filters.push(`created_at_i>${since}`);
  }
  // Очки фильтруем на стороне Algolia — меньше трафика
  if (minScore > 0) filters.push(`points>=${minScore}`);
  if (filters.length) params.set('numericFilters', filters.join(','));

  const data = await getJson(`${ALGOLIA}/${endpoint}?${params}`);
  const hits = Array.isArray(data.hits) ? data.hits : [];
  const rows = hits.map(normalizeAlgolia).filter((r) => r.title);

  if (!byDate) rows.sort((a, b) => b.score - a.score);

  return {
    query,
    days,
    minScore,
    totalFound: data.nbHits ?? rows.length,
    returned: Math.min(rows.length, limit),
    items: rows.slice(0, limit),
  };
}

/** Несколько запросов за один проход — под список ключевых слов ниши. */
export async function searchMany(queries, opts = {}) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const r = await search(q, opts);
      for (const it of r.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        results.push({ ...it, matchedQuery: q });
      }
    } catch (e) {
      results.push({ error: e.message, matchedQuery: q });
    }
    if (i < queries.length - 1) await sleep(400); // не долбим Algolia
  }
  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Вывод
// ─────────────────────────────────────────────────────────────────────────────

export function toMarkdown(items, { title = 'Hacker News' } = {}) {
  const L = [`# ${title}`, ''];
  if (!items.length) {
    L.push('Ничего не нашлось под заданные фильтры. Ослабьте --min-score или расширьте --days.');
    return L.join('\n');
  }
  items.forEach((it, n) => {
    if (it.error) {
      L.push(`### ${n + 1}. ОШИБКА по запросу «${it.matchedQuery}»: ${it.error}`);
      L.push('');
      return;
    }
    L.push(`### ${n + 1}. ${it.title}`);
    L.push(`- очки: ${it.score} | комментариев: ${it.comments}${it.matchedQuery ? ` | запрос: ${it.matchedQuery}` : ''}`);
    L.push(`- когда: ${it.ageHours != null ? `${it.ageHours} ч назад` : 'дата неизвестна'}${it.createdAt ? ` (${it.createdAt})` : ''}`);
    L.push(`- статья: ${it.url}${it.isSelfPost ? ' (текстовый пост, внешней ссылки нет)' : ''}`);
    L.push(`- обсуждение: ${it.discussion}`);
    L.push('');
  });
  L.push('---');
  L.push('');
  L.push('**HN — источник ТЕМЫ, не источник ФАКТА.** Очки показывают интерес,');
  L.push('а не достоверность. Факт брать из статьи и проверять до первоисточника:');
  L.push('`node lib/research/verify.mjs "<утверждение>" <ссылки>`.');
  L.push('Комментарии на HN полезны отдельно: там обычно лежит возражение,');
  L.push('из которого получается сильный крючок для поста.');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `
hn.mjs — Hacker News без ключей.

  node lib/research/hn.mjs top    [--limit N] [--min-score N] [--max-age Ч] [--scan N] [--json]
  node lib/research/hn.mjs best   [те же опции]
  node lib/research/hn.mjs new    [те же опции]
  node lib/research/hn.mjs show   [--limit N]          # Show HN
  node lib/research/hn.mjs ask    [--limit N]          # Ask HN
  node lib/research/hn.mjs search "<слова>" [--days N] [--min-score N] [--limit N] [--by-date] [--json]
  node lib/research/hn.mjs search-many "слово1,слово2" [--days N] [--min-score N]

Примеры:
  node lib/research/hn.mjs top --limit 10 --min-score 150
  node lib/research/hn.mjs search "ai agents" --days 7 --min-score 100
  node lib/research/hn.mjs search-many "postgres,sqlite" --days 30 --min-score 50

Свой User-Agent: export THREADS_KIT_UA="my-bot/1.0 (+me@example.com)"
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--by-date') a.byDate = true;
    else if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t === '--min-score') a.minScore = Number(argv[++i]);
    else if (t === '--max-age') a.maxAge = Number(argv[++i]);
    else if (t === '--days') a.days = Number(argv[++i]);
    else if (t === '--scan') a.scan = Number(argv[++i]);
    else if (t === '--help' || t === '-h') a.help = true;
    else a._.push(t);
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || !cmd) {
    console.log(HELP);
    return;
  }

  if (cmd === 'search' || cmd === 'search-many') {
    const q = args._[1];
    if (!q) throw new Error('Нужен поисковый запрос: node lib/research/hn.mjs search "слова"');

    if (cmd === 'search') {
      const r = await search(q, {
        days: args.days ?? 7,
        minScore: args.minScore ?? 0,
        limit: args.limit ?? 20,
        byDate: !!args.byDate,
      });
      if (args.json) console.log(JSON.stringify(r, null, 2));
      else
        console.log(
          toMarkdown(r.items, {
            title: `HN: «${q}» за ${r.days} дн., очков ≥ ${r.minScore} (найдено ${r.totalFound}, показано ${r.returned})`,
          })
        );
      return;
    }

    const queries = String(q).split(',').map((s) => s.trim()).filter(Boolean);
    const rows = await searchMany(queries, {
      days: args.days ?? 7,
      minScore: args.minScore ?? 0,
      limit: args.limit ?? 10,
    });
    if (args.json) console.log(JSON.stringify({ queries, items: rows }, null, 2));
    else console.log(toMarkdown(rows, { title: `HN: ${queries.length} запрос(ов) за ${args.days ?? 7} дн.` }));
    return;
  }

  if (['top', 'new', 'best', 'ask', 'show', 'job'].includes(cmd)) {
    const r = await topStories({
      kind: cmd,
      limit: args.limit ?? 10,
      minScore: args.minScore ?? 0,
      maxAgeHours: args.maxAge ?? 0,
      scan: args.scan ?? 60,
    });
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else
      console.log(
        toMarkdown(r.items, {
          title: `HN ${cmd}: просмотрено ${r.scanned}, подошло ${r.matched}`,
        })
      );
    return;
  }

  throw new Error(`Неизвестная команда «${cmd}».\n${HELP}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('Ошибка: ' + e.message);
    process.exit(1);
  });
}
