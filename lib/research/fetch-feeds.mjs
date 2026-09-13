#!/usr/bin/env node
/**
 * fetch-feeds.mjs — сбор свежих записей из RSS/Atom-фидов.
 *
 * Чистый Node.js (>= 18), НИ ОДНОЙ npm-зависимости: встроенный fetch +
 * собственный минимальный парсер XML (ниже). Библиотеку тащить незачем —
 * нам нужны пять полей из каждой записи, а не полная поддержка XML.
 *
 * Что делает:
 *   1) читает список фидов из config/sources.json (пример — sources.example.json);
 *   2) проверяет robots.txt каждого хоста перед запросом;
 *   3) тянет фиды по очереди с паузой, со своим User-Agent;
 *   4) парсит RSS 2.0 и Atom, приводит к одной форме;
 *   5) дедуплицирует (по ссылке и по нормализованному заголовку);
 *   6) сортирует по свежести с поправкой на weight источника;
 *   7) отдаёт JSON или markdown-сводку.
 *
 * Запуск:
 *   node lib/research/fetch-feeds.mjs                          # markdown-сводка
 *   node lib/research/fetch-feeds.mjs --json                    # JSON
 *   node lib/research/fetch-feeds.mjs --config config/my.json
 *   node lib/research/fetch-feeds.mjs --max-age 24 --limit 40
 *   node lib/research/fetch-feeds.mjs --feed https://news.ycombinator.com/rss
 *   node lib/research/fetch-feeds.mjs --lang ru --include ии,нейросет*
 *
 * Ключей и токенов здесь нет и не нужно: все источники в примере — публичные.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const KIT_ROOT = path.resolve(new URL('../../', import.meta.url).pathname);
const DEFAULT_UA = 'threads-kit-research/1.0 (+https://github.com/; contact: set your email)';

// ─────────────────────────────────────────────────────────────────────────────
// Минимальный парсер XML
//
// Сознательное ограничение: это НЕ полный XML-парсер. Он умеет ровно то, что
// нужно для RSS/Atom — найти повторяющиеся блоки <item>/<entry> и вытащить из
// них текст простых тегов и атрибуты. Он не проверяет валидность, не понимает
// DTD и вложенные одноимённые теги. Для фидов этого достаточно; если фид
// настолько кривой, что парсер его не берёт — запись просто не попадёт в
// выдачу, а фид отметится в отчёте как пустой. Молча «додумывать» нельзя.
// ─────────────────────────────────────────────────────────────────────────────

/** Разворачивает XML-сущности и снимает CDATA. */
function decodeXmlText(raw) {
  if (raw == null) return '';
  let s = String(raw);
  // CDATA может встречаться несколько раз внутри одного значения
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)));
  s = s.replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)));
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // &amp; последним, иначе развернём дважды
  return s;
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** Убирает HTML-теги и сжимает пробелы — для описаний. */
function stripHtml(s) {
  return decodeXmlText(String(s || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Вырезает все блоки <tag>...</tag> верхнего вызова. */
function extractBlocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Текст первого вхождения простого тега внутри блока. */
function tagText(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) {
    // самозакрывающийся тег текста не несёт
    return '';
  }
  return decodeXmlText(m[1]).trim();
}

/** Значение атрибута у первого тега с таким именем. */
function tagAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}\\s[^>]*${attr}\\s*=\\s*("([^"]*)"|'([^']*)')[^>]*>`, 'i');
  const m = re.exec(block);
  if (!m) return '';
  return decodeXmlText(m[2] ?? m[3] ?? '').trim();
}

/**
 * Ссылка из Atom-записи. В Atom <link> — самозакрывающийся тег с атрибутами,
 * и их обычно несколько (alternate / self / replies). Нужен alternate,
 * а если rel не указан — по спеке это и есть alternate.
 */
function atomLink(block) {
  const links = [];
  const re = /<link\s([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(block)) !== null) {
    const attrs = m[1];
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    if (!href) continue;
    const rel = /rel\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    links.push({
      href: decodeXmlText(href[2] ?? href[3] ?? ''),
      rel: (rel ? rel[2] ?? rel[3] ?? '' : 'alternate').toLowerCase(),
    });
  }
  const alt = links.find((l) => l.rel === 'alternate') || links.find((l) => l.rel === '');
  return (alt || links[0] || {}).href || '';
}

/** Разбор даты из RSS/Atom. Возвращает ISO-строку или '' — НЕ «сейчас». */
function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const t = Date.parse(s);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  return '';
}

/**
 * Парсит тело фида в массив записей.
 * Возвращает { type, items, error }. Пустой items с error — честный результат.
 */
export function parseFeed(body, sourceUrl = '') {
  const text = String(body || '');

  // Ловушка, за которую платят временем: сервер отдаёт HTTP 200 и HTML вместо
  // фида. Так ведут себя indiehackers.com/feed.xml и (по легенде) Threads
  // /@user.rss. Проверяем до парсинга.
  const head = text.slice(0, 2000).toLowerCase();
  if (!head.includes('<rss') && !head.includes('<feed') && !head.includes('<rdf')) {
    if (head.includes('<!doctype html') || head.includes('<html')) {
      return {
        type: 'html',
        items: [],
        error: 'Сервер отдал HTML, а не фид (HTTP 200 ещё не значит «фид существует»)',
      };
    }
    return { type: 'unknown', items: [], error: 'Не похоже ни на RSS, ни на Atom' };
  }

  const isAtom = head.includes('<feed');
  const blocks = isAtom ? extractBlocks(text, 'entry') : extractBlocks(text, 'item');

  const items = [];
  for (const b of blocks) {
    const title = stripHtml(tagText(b, 'title'));
    const link = isAtom ? atomLink(b) : tagText(b, 'link') || tagAttr(b, 'link', 'href');

    // Для Atom берём БОЛЕЕ ПОЗДНЮЮ из published/updated.
    // Готча, проверенная на Product Hunt 2026-09-13: там <published> — дата
    // создания продукта (бывает старше недели), а в фид он попал сегодня
    // (<updated>). Если слепо предпочитать published, вся лента выглядит
    // «протухшей» и отсекается фильтром свежести — 50 записей превращались в 0.
    let dateRaw;
    if (isAtom) {
      const pub = tagText(b, 'published');
      const upd = tagText(b, 'updated');
      const tp = pub ? Date.parse(pub) : NaN;
      const tu = upd ? Date.parse(upd) : NaN;
      if (Number.isFinite(tp) && Number.isFinite(tu)) dateRaw = tu > tp ? upd : pub;
      else dateRaw = pub || upd;
    } else {
      dateRaw = tagText(b, 'pubDate') || tagText(b, 'dc:date') || tagText(b, 'date');
    }

    const summary = isAtom
      ? stripHtml(tagText(b, 'summary') || tagText(b, 'content'))
      : stripHtml(tagText(b, 'description') || tagText(b, 'content:encoded'));

    // Google Trends кладёт объём спроса в своё расширение
    const approxTraffic = tagText(b, 'ht:approx_traffic');

    // ...а ещё вкладывает <ht:news_item> с РЕАЛЬНЫМИ ссылками на новости,
    // из-за которых запрос и вырос. Сам <link> у всех записей Trends
    // одинаковый (ведёт на тот же фид) и для проверки факта бесполезен —
    // ценность именно в этих вложенных ссылках: это и есть ответ «почему
    // сейчас». Проверено живьём 2026-09-13.
    const newsItems = extractBlocks(b, 'ht:news_item')
      .map((n) => ({
        title: stripHtml(tagText(n, 'ht:news_item_title')),
        url: tagText(n, 'ht:news_item_url'),
        source: stripHtml(tagText(n, 'ht:news_item_source')),
      }))
      .filter((n) => n.title || n.url);
    // Reddit/Atom: автор лежит внутри <author><name>
    const author =
      tagText(b, 'dc:creator') || tagText(b, 'name') || stripHtml(tagText(b, 'author'));

    if (!title && !link) continue;

    items.push({
      title,
      link: link || '',
      date: parseDate(dateRaw),
      dateRaw: String(dateRaw || '').trim(),
      summary: summary.slice(0, 500),
      author: author || '',
      ...(approxTraffic ? { approxTraffic } : {}),
      ...(newsItems.length ? { newsItems } : {}),
      sourceUrl,
    });
  }

  return { type: isAtom ? 'atom' : 'rss', items, error: items.length ? null : 'Записей не найдено' };
}

// ─────────────────────────────────────────────────────────────────────────────
// robots.txt
// ─────────────────────────────────────────────────────────────────────────────

const robotsCache = new Map();

/**
 * Тянет и разбирает robots.txt. Разбор упрощённый, но в нужную сторону:
 * при любом сомнении считаем, что НЕЛЬЗЯ (кроме случая, когда robots.txt
 * недоступен — тогда по общей практике считаем, что можно).
 */
export async function checkRobots(targetUrl, { userAgent = DEFAULT_UA, timeoutMs = 10000 } = {}) {
  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return { allowed: false, reason: 'битый URL', crawlDelay: null };
  }
  const origin = u.origin;

  if (!robotsCache.has(origin)) {
    robotsCache.set(origin, fetchRobots(origin, userAgent, timeoutMs));
  }
  const rules = await robotsCache.get(origin);

  if (rules.unavailable) {
    return { allowed: true, reason: 'robots.txt недоступен — считаем, что можно', crawlDelay: null };
  }

  const pathToCheck = u.pathname + (u.search || '');
  let best = null; // самое длинное правило выигрывает (как у Google)
  for (const rule of rules.rules) {
    if (!rule.path) continue;
    if (matchRobotsPath(pathToCheck, rule.path)) {
      if (!best || rule.path.length > best.path.length) best = rule;
    }
  }

  if (best && best.type === 'disallow') {
    return {
      allowed: false,
      reason: `robots.txt запрещает: Disallow: ${best.path}`,
      crawlDelay: rules.crawlDelay,
    };
  }
  return { allowed: true, reason: 'robots.txt не запрещает', crawlDelay: rules.crawlDelay };
}

async function fetchRobots(origin, userAgent, timeoutMs) {
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, { userAgent, timeoutMs });
    if (!res.ok) return { unavailable: true, rules: [], crawlDelay: null };
    const text = await res.text();
    return parseRobots(text, userAgent);
  } catch {
    return { unavailable: true, rules: [], crawlDelay: null };
  }
}

/**
 * Разбор robots.txt. Собираем группу для '*' и группу, чей User-agent
 * является подстрокой нашего UA (так robots и задуман). Правила из
 * подходящих групп складываем.
 */
export function parseRobots(text, userAgent = DEFAULT_UA) {
  const uaLower = String(userAgent).toLowerCase();
  const lines = String(text).split(/\r?\n/);

  const groups = [];
  let current = null;
  let lastWasUa = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === 'user-agent') {
      // подряд идущие User-agent относятся к одной группе
      if (!current || !lastWasUa) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasUa = true;
      continue;
    }
    lastWasUa = false;
    if (!current) continue;

    if (key === 'disallow') current.rules.push({ type: 'disallow', path: value });
    else if (key === 'allow') current.rules.push({ type: 'allow', path: value });
    else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) current.crawlDelay = n;
    }
  }

  const matched = groups.filter((g) =>
    g.agents.some((a) => a === '*' || (a && a !== '*' && uaLower.includes(a)))
  );

  const rules = [];
  let crawlDelay = null;
  for (const g of matched) {
    rules.push(...g.rules);
    if (g.crawlDelay != null) crawlDelay = Math.max(crawlDelay ?? 0, g.crawlDelay);
  }
  return { unavailable: false, rules, crawlDelay };
}

/** Сопоставление пути с шаблоном robots (* и $). */
function matchRobotsPath(pathname, pattern) {
  if (pattern === '') return false; // пустой Disallow ничего не запрещает
  const anchored = pattern.endsWith('$');
  const pat = anchored ? pattern.slice(0, -1) : pattern;
  const parts = pat.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp('^' + parts.join('.*') + (anchored ? '$' : ''));
  return re.test(pathname);
}

// ─────────────────────────────────────────────────────────────────────────────
// Сеть
// ─────────────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, { userAgent = DEFAULT_UA, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'ru,en;q=0.8',
      },
      redirect: 'follow',
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Готча, на которой ловится каждый второй: HTTP-заголовки — latin-1. Если в
 * User-Agent попала кириллица (а в шаблоне конфига там стоит «укажите свою
 * почту»), fetch падает с «Cannot convert argument to a ByteString» на КАЖДОМ
 * источнике, и отчёт выглядит так, будто лежит весь интернет. Проверяем один
 * раз и говорим вслух, в чём дело.
 */
export function assertUsableUserAgent(ua) {
  const s = String(ua || '');
  if (!s.trim()) throw new Error('User-Agent пуст — задайте userAgent в конфиге.');
  const bad = [...s].find((ch) => ch.codePointAt(0) > 255);
  if (bad) {
    throw new Error(
      `В User-Agent есть не-latin1 символ «${bad}» — HTTP-заголовки этого не принимают ` +
        `и упадут ВСЕ источники. Перепишите userAgent латиницей, например: ` +
        `"threads-kit-research/1.0 (+contact: you@example.com)". Текущее значение: ${s}`
    );
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Нормализация и дедупликация
// ─────────────────────────────────────────────────────────────────────────────

/** Ссылка без utm-мусора и трекеров — чтобы дедупликация работала. */
export function normalizeLink(link) {
  try {
    const u = new URL(link);
    const drop = [];
    for (const k of u.searchParams.keys()) {
      if (/^(utm_|yclid|gclid|fbclid|ref|ref_src|source|at_medium|at_campaign)/i.test(k)) drop.push(k);
    }
    drop.forEach((k) => u.searchParams.delete(k));
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return String(link || '').trim().toLowerCase();
  }
}

/** Ключ заголовка: одна и та же новость у двух источников названа почти одинаково. */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[«»"'`’“”()[\]{}.,;:!?–—\-_/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Совпадение ключевого слова по ГРАНИЦЕ СЛОВА, а не по подстроке.
 *
 * Готча, поймана живьём 2026-09-13: короткое русское слово «ии» (ниша про
 * искусственный интеллект — ровно тот случай, когда оно нужно) как подстрока
 * находится в «ситуации», «коллизии», «расширении». Из 3 «совпадений» реальным
 * было одно («ии-агент»). Поэтому вокруг слова требуется небраквенный символ.
 *
 * \b в JS не работает с кириллицей (она не входит в \w), поэтому границу
 * задаём вручную через класс букв и цифр обоих алфавитов.
 *
 * Слово, заданное с * на конце («нейросет*»), ищется как префикс: совпадёт
 * «нейросети», «нейросетью». Без * требуется совпадение целого слова.
 */
export function keywordMatches(haystack, keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return false;
  const hay = String(haystack || '').toLowerCase();

  const prefixMode = kw.endsWith('*');
  const core = prefixMode ? kw.slice(0, -1) : kw;
  if (!core) return false;

  const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const L = 'a-zа-яё0-9ёіїєґ';
  // слева — не буква/цифра; справа — либо не буква/цифра, либо (в режиме
  // префикса) любое продолжение слова
  const right = prefixMode ? '' : `(?![${L}])`;
  const re = new RegExp(`(?<![${L}])${esc}${right}`, 'iu');
  return re.test(hay);
}

export function dedupe(items) {
  const seenLink = new Set();
  const seenTitle = new Set();
  const out = [];
  const dropped = [];
  for (const it of items) {
    // Готча Google Trends (проверено 2026-09-13): у ВСЕХ его записей <link>
    // один и тот же — адрес самого фида. Дедупликация по ссылке схлопнула бы
    // 20 разных трендов в один. Поэтому для таких записей ссылку как ключ не
    // используем, различаем их по заголовку.
    const linkIsShared = it.link && it.sourceUrl && normalizeLink(it.link) === normalizeLink(it.sourceUrl);
    const lk = it.link && !linkIsShared ? normalizeLink(it.link) : '';
    const tk = normalizeTitle(it.title);
    if (lk && seenLink.has(lk)) {
      dropped.push({ ...it, dedupeReason: 'дубль по ссылке' });
      continue;
    }
    // Короткие заголовки по умолчанию не считаем ключом (слишком много
    // ложных совпадений), но у записей без собственной ссылки — например
    // трендовых запросов Google Trends — заголовок единственный различитель.
    const minTitleKey = lk ? 12 : 2;
    if (tk && tk.length > minTitleKey && seenTitle.has(tk)) {
      dropped.push({ ...it, dedupeReason: 'дубль по заголовку' });
      continue;
    }
    if (lk) seenLink.add(lk);
    if (tk) seenTitle.add(tk);
    out.push(it);
  }
  return { items: out, dropped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Конфиг
// ─────────────────────────────────────────────────────────────────────────────

export async function loadConfig(configPath) {
  const candidates = configPath
    ? [path.resolve(configPath)]
    : [
        path.join(KIT_ROOT, 'config', 'sources.json'),
        path.join(KIT_ROOT, 'config', 'sources.example.json'),
      ];

  for (const p of candidates) {
    try {
      const raw = await readFile(p, 'utf8');
      const cfg = JSON.parse(raw);
      return { cfg, path: p };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw new Error(`Не читается конфиг ${p}: ${e.message}`);
      }
    }
  }
  throw new Error(
    `Конфиг источников не найден. Ожидался один из:\n  ${candidates.join('\n  ')}\n` +
      `Скопируйте config/sources.example.json в config/sources.json и оставьте нужные фиды.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Основной сбор
// ─────────────────────────────────────────────────────────────────────────────

export async function collect(options = {}) {
  const {
    feeds = [],
    userAgent = DEFAULT_UA,
    maxAgeHours = 72,
    perFeedLimit = 25,
    delayMs = 1500,
    timeoutMs = 15000,
    respectRobots = true,
    keywordsInclude = [],
    keywordsExclude = [],
    lang = null,
    onProgress = () => {},
  } = options;

  assertUsableUserAgent(userAgent);

  const report = [];
  const all = [];
  const now = Date.now();
  const cutoff = maxAgeHours > 0 ? now - maxAgeHours * 3600_000 : null;

  const inc = keywordsInclude.map((k) => String(k).toLowerCase()).filter(Boolean);
  const exc = keywordsExclude.map((k) => String(k).toLowerCase()).filter(Boolean);

  const selected = feeds.filter((f) => !lang || !f.lang || f.lang === lang);

  for (let i = 0; i < selected.length; i++) {
    const feed = selected[i];
    const entry = { id: feed.id || feed.url, url: feed.url, ok: false, count: 0, note: null };
    onProgress(`[${i + 1}/${selected.length}] ${entry.id}`);

    try {
      if (respectRobots) {
        const robots = await checkRobots(feed.url, { userAgent, timeoutMs });
        entry.robots = robots.reason;
        if (!robots.allowed) {
          entry.note = `ПРОПУЩЕН: ${robots.reason}`;
          report.push(entry);
          continue;
        }
        if (robots.crawlDelay != null) entry.crawlDelay = robots.crawlDelay;
      }

      const res = await fetchWithTimeout(feed.url, { userAgent, timeoutMs });
      entry.status = res.status;
      if (!res.ok) {
        entry.note = `HTTP ${res.status}`;
        report.push(entry);
        continue;
      }
      const body = await res.text();
      const parsed = parseFeed(body, feed.url);
      entry.type = parsed.type;

      if (!parsed.items.length) {
        entry.note = parsed.error || 'пусто';
        report.push(entry);
        continue;
      }

      let items = parsed.items.map((it) => ({
        ...it,
        source: feed.id || feed.url,
        sourceTitle: feed.title || feed.id || feed.url,
        kind: feed.kind || 'topic',
        lang: feed.lang || '',
        weight: Number.isFinite(feed.weight) ? feed.weight : 1,
      }));

      const beforeAge = items.length;
      if (cutoff != null) {
        // Запись без даты НЕ выбрасываем: у части фидов даты нет вовсе.
        // Но помечаем — в карточке темы дату придётся искать руками.
        items = items.filter((it) => !it.date || Date.parse(it.date) >= cutoff);
      }
      const afterAge = items.length;

      // Область поиска слов. Важно: у трендов Google сам заголовок — это просто
      // имя или слово («иван олейников»), а тема раскрывается только в
      // приложенных новостях. Если искать стоп-слова лишь в title+summary,
      // спортивные и политические тренды проходят фильтр, потому что в
      // заголовке нет ни одного запретного слова.
      const стогСена = (it) => {
        const части = [it.title, it.summary];
        if (it.newsItems?.length) {
          for (const n of it.newsItems) части.push(n.title, n.source);
        }
        return части.filter(Boolean).join(' ');
      };

      if (inc.length) {
        items = items.filter((it) => {
          const hay = стогСена(it);
          return inc.some((k) => keywordMatches(hay, k));
        });
      }
      if (exc.length) {
        items = items.filter((it) => {
          const hay = стогСена(it);
          return !exc.some((k) => keywordMatches(hay, k));
        });
      }

      items = items.slice(0, perFeedLimit);
      all.push(...items);

      entry.ok = true;
      entry.count = items.length;
      entry.note = `получено ${beforeAge}, по свежести ${afterAge}, после фильтров ${items.length}`;
      report.push(entry);
    } catch (e) {
      entry.note = `ошибка: ${e.message}`;
      report.push(entry);
    }

    // Пауза между источниками. Если robots попросил больше — слушаемся.
    if (i < selected.length - 1) {
      const wait = Math.max(delayMs, (entry.crawlDelay || 0) * 1000);
      if (wait > 0) await sleep(Math.min(wait, 30000));
    }
  }

  const { items: unique, dropped } = dedupe(all);

  // Сортировка: свежесть с поправкой на вес источника.
  // Запись без даты уходит в конец — её нельзя выдать за свежую.
  const scored = unique.map((it) => {
    const t = it.date ? Date.parse(it.date) : NaN;
    const ageHours = Number.isFinite(t) ? Math.max(0, (now - t) / 3600_000) : null;
    const freshness = ageHours == null ? 0 : 1 / (1 + ageHours / 12);
    return { ...it, ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10, score: Math.round(freshness * (it.weight || 1) * 1000) / 1000 };
  });
  scored.sort((a, b) => b.score - a.score);

  return {
    generatedAt: new Date().toISOString(),
    userAgent,
    params: { maxAgeHours, perFeedLimit, delayMs, respectRobots, lang, keywordsInclude: inc, keywordsExclude: exc },
    feeds: report,
    stats: {
      feedsTried: selected.length,
      feedsOk: report.filter((r) => r.ok).length,
      itemsRaw: all.length,
      itemsUnique: unique.length,
      itemsDropped: dropped.length,
      itemsNoDate: scored.filter((i) => i.ageHours == null).length,
    },
    items: scored,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Вывод
// ─────────────────────────────────────────────────────────────────────────────

export function toMarkdown(result, { limit = 30 } = {}) {
  const L = [];
  L.push(`# Свежее из фидов — ${result.generatedAt}`);
  L.push('');
  const s = result.stats;
  L.push(
    `Источников опрошено: ${s.feedsTried}, ответили: ${s.feedsOk}. ` +
      `Записей: ${s.itemsRaw} → после дедупликации ${s.itemsUnique} (снято ${s.itemsDropped}).` +
      (s.itemsNoDate ? ` Без даты: ${s.itemsNoDate} — дату искать руками.` : '')
  );
  L.push('');

  L.push('## Источники');
  L.push('');
  L.push('| Источник | Статус | Записей | Примечание |');
  L.push('|---|---|---|---|');
  for (const f of result.feeds) {
    L.push(`| ${f.id} | ${f.ok ? 'ок' : 'НЕТ'} | ${f.count} | ${(f.note || '').replace(/\|/g, '/')} |`);
  }
  L.push('');

  const topics = result.items.filter((i) => i.kind !== 'fact');
  const facts = result.items.filter((i) => i.kind === 'fact');

  const block = (title, arr) => {
    if (!arr.length) return;
    L.push(`## ${title}`);
    L.push('');
    arr.slice(0, limit).forEach((it, n) => {
      const age = it.ageHours == null ? 'дата НЕ УКАЗАНА' : `${it.ageHours} ч назад`;
      L.push(`### ${n + 1}. ${it.title || '(без заголовка)'}`);
      L.push(`- источник: ${it.sourceTitle} (${it.source})`);
      L.push(`- когда: ${age}${it.date ? ` — ${it.date}` : ''}`);
      L.push(`- ссылка: ${it.link || '(нет)'}`);
      if (it.approxTraffic) L.push(`- объём спроса: ${it.approxTraffic}`);
      if (it.summary) L.push(`- о чём: ${it.summary.slice(0, 220)}`);
      if (it.newsItems?.length) {
        L.push('- почему сейчас (новости, поднявшие запрос):');
        it.newsItems.slice(0, 3).forEach((n) => {
          L.push(`  - ${n.title || '(без заголовка)'}${n.source ? ` — ${n.source}` : ''}`);
          if (n.url) L.push(`    ${n.url}`);
        });
      }
      L.push('');
    });
  };

  block('Темы (о чём говорят)', topics);
  block('Источники фактов', facts);

  L.push('---');
  L.push('');
  L.push('**Это сырьё, а не готовые темы.** Прежде чем писать пост:');
  L.push('1. проверить факт до первоисточника (`lib/research/verify.mjs`);');
  L.push('2. убедиться, что у факта есть дата;');
  L.push('3. перепечатка источником НЕ считается.');
  L.push('');
  L.push('Процедура целиком — `skills/threads-research/SKILL.md`.');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t === '--quiet') a.quiet = true;
    else if (t === '--no-robots') a.noRobots = true;
    else if (t === '--config') a.config = argv[++i];
    else if (t === '--feed') (a.feed ||= []).push(argv[++i]);
    else if (t === '--max-age') a.maxAge = Number(argv[++i]);
    else if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t === '--delay') a.delay = Number(argv[++i]);
    else if (t === '--lang') a.lang = argv[++i];
    else if (t === '--include') a.include = String(argv[++i]).split(',');
    else if (t === '--exclude') a.exclude = String(argv[++i]).split(',');
    else if (t === '--help' || t === '-h') a.help = true;
    else a._.push(t);
  }
  return a;
}

const HELP = `
fetch-feeds.mjs — сбор свежих записей из RSS/Atom.

  node lib/research/fetch-feeds.mjs [опции]

  --json              выдать JSON вместо markdown
  --config <файл>     свой конфиг (по умолчанию config/sources.json,
                      затем config/sources.example.json)
  --feed <url>        взять только этот фид (можно несколько раз);
                      конфиг при этом не нужен
  --max-age <часы>    отсечь старое (по умолчанию из конфига, 72)
  --limit <n>         сколько записей показать в сводке (30)
  --delay <мс>        пауза между источниками (1500)
  --lang ru|en        только фиды этого языка
  --include a,b       оставить записи, где есть одно из слов (по границе слова:
                      «ии» не совпадёт с «ситуации»; «нейросет*» — по префиксу)
  --exclude a,b       выбросить записи с этими словами (правила те же)
  --no-robots         НЕ проверять robots.txt (по умолчанию проверяем;
                      выключать только если точно знаете, что делаете)
  --quiet             без прогресса в stderr
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  let feeds;
  let cfg = {};
  let cfgPath = '(не использован: заданы --feed)';

  if (args.feed && args.feed.length) {
    feeds = args.feed.map((u, i) => ({ id: `cli${i + 1}`, title: u, url: u, kind: 'topic', weight: 1 }));
  } else {
    const loaded = await loadConfig(args.config);
    cfg = loaded.cfg;
    cfgPath = loaded.path;
    feeds = Array.isArray(cfg.feeds) ? cfg.feeds : [];
    if (!feeds.length) throw new Error(`В конфиге ${cfgPath} нет ни одного активного фида (поле "feeds").`);
  }

  const d = cfg.defaults || {};
  const result = await collect({
    feeds,
    userAgent: cfg.userAgent || DEFAULT_UA,
    maxAgeHours: args.maxAge ?? d.maxAgeHours ?? 72,
    perFeedLimit: d.perFeedLimit ?? 25,
    delayMs: args.delay ?? d.delayMs ?? 1500,
    timeoutMs: d.timeoutMs ?? 15000,
    respectRobots: args.noRobots ? false : d.respectRobots !== false,
    keywordsInclude: args.include ?? cfg.keywordsInclude ?? [],
    keywordsExclude: args.exclude ?? cfg.keywordsExclude ?? [],
    lang: args.lang || null,
    onProgress: args.quiet ? () => {} : (m) => process.stderr.write(m + '\n'),
  });

  result.configPath = cfgPath;

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(toMarkdown(result, { limit: args.limit ?? 30 }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('Ошибка: ' + e.message);
    process.exit(1);
  });
}
