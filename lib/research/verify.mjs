#!/usr/bin/env node
/**
 * verify.mjs — ПОМОЩНИК проверки факта. Не детектор правды.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ЧТО ЭТО ТАКОЕ И ЧЕГО ОНО НЕ ДЕЛАЕТ
 *
 * Этот файл НЕ определяет, правда ли утверждение. Программа этого не умеет и
 * уметь не может. Она делает механическую работу, на которой человек и Клод
 * ошибаются чаще всего:
 *
 *   — тянет каждую ссылку и смотрит, что там реально лежит;
 *   — отличает похоже-первоисточник от похоже-перепечатки (по признакам,
 *     а не по истине): есть ли ссылка «по данным», «according to», «source»,
 *     совпадает ли домен с тем, кого цитируют;
 *   — ищет дату публикации и дату обновления;
 *   — вытаскивает все числа со страницы и сверяет с числами из утверждения:
 *     сходятся ли они между источниками или каждый пишет своё;
 *   — показывает, что нашлось, и ставит ВОПРОСЫ.
 *
 * Решение «идёт факт в пост или нет» принимает Клод по правилам из
 * skills/threads-research/SKILL.md, а спорные случаи — владелец. Вывод этой
 * программы — материал для решения, а не решение.
 *
 * Почему так: «зелёный» автоматический вердикт опаснее отсутствия проверки.
 * Он снимает ответственность и усыпляет — а разбирают пост в комментариях
 * живые люди, у которых есть исходная статья.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Запуск:
 *   node lib/research/verify.mjs "утверждение с цифрой 47%" https://a.com https://b.com
 *   node lib/research/verify.mjs --claim "..." --url https://a.com --json
 *   node lib/research/verify.mjs --claim "..." --url https://a.com --cited-domain who.int
 *
 * Ключи не нужны: работает с публичными страницами.
 */

const UA = process.env.THREADS_KIT_UA || 'threads-kit-research/1.0 (+contact: set THREADS_KIT_UA)';

// ─────────────────────────────────────────────────────────────────────────────
// Признаки перепечатки и первоисточника
// ─────────────────────────────────────────────────────────────────────────────

/** Слова, которыми перепечатка выдаёт себя: она ссылается на кого-то ещё. */
const REPRINT_MARKERS = [
  'по данным', 'по информации', 'сообщает', 'сообщил', 'пишет', 'со ссылкой на',
  'как сообщает', 'передаёт', 'передает', 'источник:', 'источники:', 'об этом пишет',
  'according to', 'as reported by', 'reported by', 'cited by', 'sources said',
  'told reuters', 'told bloomberg', 'first reported',
];
// Осторожно со слишком общими словами: «via» встречается в любом тексте
// («via email», «via API») и давало ложную «перепечатку» даже на личном блоге
// автора. Проверено 2026-09-13 на terrytao.wordpress.com. Поэтому маркеры
// выше — только те, что действительно указывают на пересказ чужого.

// Технический шум в ссылках: CDN, кнопки соцсетей, подписки. К источнику
// факта отношения не имеет, но забивает список исходящих доменов.
const BOILERPLATE_DOMAINS = [
  'wordpress.com', 'wp.com', 'gravatar.com', 'static.com', 'gstatic.com',
  'googleapis.com', 'google.com', 'profile.google.com', 'doubleclick.net',
  'cloudflare.com', 'jquery.com', 'fontawesome.com', 'w3.org', 'schema.org',
  'creativecommons.org', 'apple.com', 'play.google.com', 'itunes.apple.com',
];

/** Слова, типичные для первоисточника: он сам провёл/объявил. */
const PRIMARY_MARKERS = [
  'мы провели', 'наше исследование', 'мы измерили', 'мы опросили', 'наши данные',
  'пресс-релиз', 'официальное заявление', 'мы объявляем', 'мы запускаем',
  'we surveyed', 'we measured', 'our study', 'our research', 'our data', 'we found',
  'press release', 'we are announcing', 'we announce', 'methodology', 'методология',
  'выборка', 'sample size', 'n =', 'respondents', 'респондент',
];

/** Домены, которые по своей природе — первоисточники (не исчерпывающе). */
const PRIMARY_DOMAIN_HINTS = [
  '.gov', '.gov.uk', '.europa.eu', 'who.int', 'oecd.org', 'worldbank.org', 'imf.org',
  'rosstat.gov.ru', 'cbr.ru', 'nalog.gov.ru', 'arxiv.org', 'doi.org', 'nature.com',
  'science.org', 'nih.gov', 'pubmed.ncbi.nlm.nih.gov', 'census.gov', 'eurostat',
];

/** Агрегаторы: сюда ссылаться как на источник нельзя, это витрина. */
const AGGREGATOR_HINTS = [
  'news.google.', 'news.yandex.', 'yandex.ru/news', 'flipboard.com', 'reddit.com',
  'news.ycombinator.com', 'medium.com', 'dzen.ru', 'zen.yandex', 'pinterest.',
  'x.com', 'twitter.com', 'facebook.com', 'vk.com', 't.me', 'threads.net',
  'linkedin.com/posts', 'quora.com', 'pikabu.ru',
];

// ─────────────────────────────────────────────────────────────────────────────
// Числа
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Вытаскивает числа с единицами. Русский и английский формат:
 * «47%», «1 200 000», «3,5 млрд», «$2.4bn», «12 тыс.»
 * Возвращает нормализованные значения, чтобы «3,5 млрд» и «3500000000»
 * оказались одним числом.
 */
export function extractNumbers(text) {
  const s = String(text || '');
  const out = [];
  // число + необязательный множитель + необязательный %
  const re =
    /(-?\d[\d\s\u00a0.,]*)\s*(%|процент\w*|percent|млрд|млн|тыс\.?|миллиард\w*|миллион\w*|тысяч\w*|billion|million|thousand|bn|mn|k\b)?/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const rawNum = m[1];
    const unitRaw = (m[2] || '').toLowerCase();
    if (!rawNum || !/\d/.test(rawNum)) continue;

    // Нормализуем запись числа. Осторожно: «1,5» — это 1.5, а «1,500» — 1500.
    let cleaned = rawNum.replace(/[\s\u00a0]/g, '');
    const commaGroups = /^\d{1,3}(,\d{3})+$/.test(cleaned);
    const dotGroups = /^\d{1,3}(\.\d{3})+$/.test(cleaned);
    if (commaGroups) cleaned = cleaned.replace(/,/g, '');
    else if (dotGroups) cleaned = cleaned.replace(/\./g, '');
    else cleaned = cleaned.replace(/,/g, '.');
    // если осталось несколько точек — запись мусорная, пропускаем
    if ((cleaned.match(/\./g) || []).length > 1) continue;

    let value = Number(cleaned);
    if (!Number.isFinite(value)) continue;

    let mult = 1;
    let kind = 'число';
    if (/^(%|процент|percent)/.test(unitRaw)) kind = 'процент';
    else if (/млрд|миллиард|billion|^bn$/.test(unitRaw)) { mult = 1e9; kind = 'масштаб'; }
    else if (/млн|миллион|million|^mn$/.test(unitRaw)) { mult = 1e6; kind = 'масштаб'; }
    else if (/тыс|тысяч|thousand|^k$/.test(unitRaw)) { mult = 1e3; kind = 'масштаб'; }

    // отбрасываем годы — они почти всегда шум при сверке цифр
    const isYear = kind === 'число' && value >= 1900 && value <= 2100 && Number.isInteger(value);

    out.push({
      raw: (rawNum.trim() + (m[2] ? ' ' + m[2] : '')).replace(/\s+/g, ' ').trim(),
      value: value * mult,
      kind,
      isYear,
    });
  }
  return out;
}

/** Числа из утверждения, годы отброшены — их сверять бессмысленно. */
export function claimNumbers(claim) {
  return extractNumbers(claim).filter((n) => !n.isYear);
}

/** Есть ли число (с допуском) среди найденных на странице. */
function numberPresent(target, pool, tolerance = 0.02) {
  return pool.some((n) => {
    if (n.kind === 'процент' && target.kind !== 'процент') return false;
    if (target.kind === 'процент' && n.kind !== 'процент') return false;
    if (target.value === 0) return n.value === 0;
    return Math.abs(n.value - target.value) / Math.abs(target.value) <= tolerance;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Даты
// ─────────────────────────────────────────────────────────────────────────────

const RU_MONTHS = {
  январ: 1, феврал: 2, март: 3, апрел: 4, мая: 5, май: 5, июн: 6,
  июл: 7, август: 8, сентябр: 9, октябр: 10, ноябр: 11, декабр: 12,
};

/** Ищет дату публикации: сначала в метаданных, потом в тексте. */
export function findDates(html) {
  const found = [];
  const add = (value, where) => {
    if (!value) return;
    const t = Date.parse(value);
    if (Number.isFinite(t)) found.push({ iso: new Date(t).toISOString(), where, raw: value });
  };

  const meta = (patterns) => {
    for (const p of patterns) {
      const m = p.exec(html);
      if (m) return m[1];
    }
    return null;
  };

  // Метатеги — самый надёжный признак
  add(
    meta([
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
      /<meta[^>]+name=["'](?:pubdate|publishdate|date|dc\.date|citation_publication_date)["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
    ]),
    'метатег «опубликовано»'
  );
  add(
    meta([
      /<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+itemprop=["']dateModified["'][^>]+content=["']([^"']+)["']/i,
    ]),
    'метатег «обновлено»'
  );

  // JSON-LD
  let m;
  const ld = /"datePublished"\s*:\s*"([^"]+)"/gi;
  while ((m = ld.exec(html)) !== null) add(m[1], 'JSON-LD datePublished');
  const ldMod = /"dateModified"\s*:\s*"([^"]+)"/gi;
  while ((m = ldMod.exec(html)) !== null) add(m[1], 'JSON-LD dateModified');

  // <time datetime="...">
  const timeTag = /<time[^>]+datetime=["']([^"']+)["']/gi;
  while ((m = timeTag.exec(html)) !== null) add(m[1], 'тег <time>');

  // Текстовая русская дата: «12 сентября 2026»
  const textPlain = html.replace(/<[^>]+>/g, ' ');
  const ruDate = /(\d{1,2})\s+([а-яё]{3,10})\s+(\d{4})/gi;
  while ((m = ruDate.exec(textPlain)) !== null) {
    const key = Object.keys(RU_MONTHS).find((k) => m[2].toLowerCase().startsWith(k));
    if (!key) continue;
    const mm = String(RU_MONTHS[key]).padStart(2, '0');
    const dd = String(m[1]).padStart(2, '0');
    add(`${m[3]}-${mm}-${dd}T00:00:00Z`, `текст «${m[0]}»`);
  }

  // ISO в тексте
  const isoText = /\b(20\d{2}-\d{2}-\d{2})\b/g;
  while ((m = isoText.exec(textPlain)) !== null) add(m[1] + 'T00:00:00Z', 'дата в тексте');

  // убираем дубли по ISO, оставляя первый (самый надёжный) источник
  const seen = new Set();
  const uniq = [];
  for (const f of found) {
    if (seen.has(f.iso)) continue;
    seen.add(f.iso);
    uniq.push(f);
  }
  return uniq;
}

// ─────────────────────────────────────────────────────────────────────────────
// Загрузка и разбор одной ссылки
// ─────────────────────────────────────────────────────────────────────────────

function textFromHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Внешние домены, на которые страница ссылается рядом со словами-маркерами. */
function outboundDomains(html, selfHost) {
  const doms = new Map();
  const re = /<a\s[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const h = hostOf(m[1]);
    if (!h || h === selfHost) continue;
    if (AGGREGATOR_HINTS.some((a) => h.includes(a.replace(/\/.*$/, '').replace(/\.$/, '')))) continue;
    if (BOILERPLATE_DOMAINS.some((b) => h === b || h.endsWith('.' + b))) continue;
    const anchor = textFromHtml(m[2]).slice(0, 80);
    if (!doms.has(h)) doms.set(h, { host: h, url: m[1], anchor, count: 0 });
    doms.get(h).count++;
  }
  return [...doms.values()].sort((a, b) => b.count - a.count);
}

export async function inspectUrl(url, { claim = '', citedDomain = '', timeoutMs = 20000 } = {}) {
  const result = {
    url,
    host: hostOf(url),
    ok: false,
    status: null,
    error: null,
    title: '',
    dates: [],
    publishedAt: null,
    ageDays: null,
    numbers: [],
    claimNumbersFound: [],
    claimNumbersMissing: [],
    reprintMarkers: [],
    primaryMarkers: [],
    outbound: [],
    signals: [],
    questions: [],
  };

  if (AGGREGATOR_HINTS.some((a) => (result.host + '/').includes(a.replace(/\.$/, '')))) {
    result.signals.push('АГРЕГАТОР/СОЦСЕТЬ: как источник факта не годится в принципе');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let html = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'ru,en;q=0.8' },
      redirect: 'follow',
      signal: ac.signal,
    });
    result.status = res.status;
    result.finalUrl = res.url;
    if (res.url && hostOf(res.url) !== result.host) {
      result.signals.push(`РЕДИРЕКТ на другой домен: ${hostOf(res.url)} — проверяйте именно его`);
    }
    if (!res.ok) {
      result.error = `HTTP ${res.status}`;
      result.questions.push('Страница не открылась. Ссылка в пост не годится: читатель тоже её не откроет.');
      return result;
    }
    html = await res.text();
    result.ok = true;
  } catch (e) {
    result.error = e.name === 'AbortError' ? `таймаут ${timeoutMs} мс` : e.message;
    result.questions.push(
      'Не удалось загрузить страницу из этой среды. Это МОЖЕТ быть ограничение песочницы, ' +
        'а не проблема источника — перепроверьте вручную, прежде чем отбрасывать.'
    );
    return result;
  } finally {
    clearTimeout(timer);
  }

  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  result.title = titleM ? textFromHtml(titleM[1]).slice(0, 200) : '';

  // Даты
  result.dates = findDates(html).slice(0, 8);
  const pub = result.dates.find((d) => /опубликовано|datePublished/i.test(d.where)) || result.dates[0];
  if (pub) {
    result.publishedAt = pub.iso;
    result.ageDays = Math.round((Date.now() - Date.parse(pub.iso)) / 86400000);
  } else {
    result.signals.push('ДАТЫ НЕ НАЙДЕНО — по правилам скила факт без даты в пост не идёт');
    result.questions.push('Найдите дату публикации вручную (подвал, автор, архив). Нет даты — нет факта.');
  }

  const text = textFromHtml(html);
  const textLower = text.toLowerCase();

  // Маркеры
  result.reprintMarkers = REPRINT_MARKERS.filter((k) => textLower.includes(k)).slice(0, 8);
  result.primaryMarkers = PRIMARY_MARKERS.filter((k) => textLower.includes(k)).slice(0, 8);

  // Числа
  const pageNumbers = extractNumbers(text);
  result.numbers = pageNumbers
    .filter((n) => !n.isYear)
    .slice(0, 40)
    .map((n) => n.raw);

  if (claim) {
    const want = claimNumbers(claim);
    for (const w of want) {
      if (numberPresent(w, pageNumbers)) result.claimNumbersFound.push(w.raw);
      else result.claimNumbersMissing.push(w.raw);
    }
    if (want.length && result.claimNumbersMissing.length === want.length) {
      result.signals.push('НИ ОДНО число из утверждения на странице не найдено — возможно, не тот источник');
    }
  }

  // Исходящие ссылки
  result.outbound = outboundDomains(html, result.host).slice(0, 8);

  // Первоисточник или перепечатка — по признакам
  const domainPrimary = PRIMARY_DOMAIN_HINTS.some((d) => result.host.includes(d.replace(/^\./, '')));
  if (domainPrimary) result.signals.push('Домен из числа типичных первоисточников (гос/научный)');

  // Наличие исходящих ссылок САМО ПО СЕБЕ не признак перепечатки: любая
  // содержательная статья ссылается на литературу. Проверено 2026-09-13:
  // личный блог автора (terrytao.wordpress.com) из-за этого ошибочно
  // помечался перепечаткой. Вес даём только словам-маркерам пересказа.
  const reprintScore = result.reprintMarkers.length;
  const primaryScore = result.primaryMarkers.length + (domainPrimary ? 3 : 0);

  if (citedDomain) {
    const cd = citedDomain.replace(/^www\./, '').toLowerCase();
    if (result.host.includes(cd)) result.signals.push(`Домен совпадает с тем, кого цитируют (${cd}) — похоже на первоисточник`);
    else {
      const linksToCited = result.outbound.find((o) => o.host.includes(cd));
      if (linksToCited) result.signals.push(`Ссылается на ${linksToCited.host} — идите ТУДА, это и есть источник: ${linksToCited.url}`);
      else result.signals.push(`Цитируют ${cd}, но страница на него даже не ссылается — слабое звено`);
    }
  }

  if (primaryScore > reprintScore) result.verdictHint = 'похоже на ПЕРВОИСТОЧНИК (по признакам, не факт)';
  else if (reprintScore > primaryScore) result.verdictHint = 'похоже на ПЕРЕПЕЧАТКУ (по признакам, не факт)';
  else result.verdictHint = 'НЕ ОПРЕДЕЛЕНО — решайте сами, признаки не перевесили';

  if (result.reprintMarkers.length) {
    result.questions.push(
      `Найдены слова перепечатки (${result.reprintMarkers.slice(0, 3).join(', ')}). ` +
        'Кого они цитируют? Дойдите до него — перепечатка источником не считается.'
    );
  }
  if (result.outbound.length) {
    result.questions.push(
      `Страница ссылается на: ${result.outbound.slice(0, 3).map((o) => o.host).join(', ')}. ` +
        'Если факт пришёл оттуда — проверяйте там.'
    );
  }
  if (result.ageDays != null && result.ageDays > 365) {
    result.questions.push(`Источнику ${result.ageDays} дн. Для «актуального» поста это старо — есть ли свежие данные?`);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Сверка нескольких источников
// ─────────────────────────────────────────────────────────────────────────────

export async function verify(claim, urls, opts = {}) {
  const reports = [];
  for (let i = 0; i < urls.length; i++) {
    reports.push(await inspectUrl(urls[i], { ...opts, claim }));
    if (i < urls.length - 1) await new Promise((r) => setTimeout(r, 800));
  }

  const want = claim ? claimNumbers(claim) : [];
  const agreement = want.map((w) => {
    const confirm = reports.filter((r) => r.claimNumbersFound.includes(w.raw)).map((r) => r.host);
    const silent = reports.filter((r) => r.ok && !r.claimNumbersFound.includes(w.raw)).map((r) => r.host);
    return { number: w.raw, confirmedBy: confirm, notFoundOn: silent };
  });

  const checklist = [
    {
      q: 'Есть первоисточник, а не перепечатка?',
      status: reports.some((r) => /ПЕРВОИСТОЧНИК/.test(r.verdictHint || '')) ? 'похоже, да' : 'НЕ ПОДТВЕРЖДЕНО',
    },
    {
      q: 'У факта есть дата?',
      status: reports.some((r) => r.publishedAt) ? 'да' : 'НЕТ — стоп',
    },
    {
      q: 'Цифры из утверждения нашлись в источнике?',
      status: !want.length
        ? 'в утверждении нет цифр — сверять нечего'
        : agreement.every((a) => a.confirmedBy.length)
          ? 'все нашлись'
          : 'НЕ ВСЕ: ' + agreement.filter((a) => !a.confirmedBy.length).map((a) => a.number).join(', '),
    },
    {
      q: 'Подтверждение больше чем из одного независимого места?',
      status: reports.filter((r) => r.ok).length > 1 ? `открылось источников: ${reports.filter((r) => r.ok).length}` : 'только один — слабо',
    },
  ];

  return { claim, checkedAt: new Date().toISOString(), reports, agreement, checklist };
}

// ─────────────────────────────────────────────────────────────────────────────
// Вывод
// ─────────────────────────────────────────────────────────────────────────────

export function toMarkdown(res) {
  const L = [];
  L.push('# Проверка факта');
  L.push('');
  L.push(`**Утверждение:** ${res.claim || '(не задано)'}`);
  L.push(`**Проверено:** ${res.checkedAt}`);
  L.push('');
  L.push('> Это материал для решения, а НЕ вердикт. Решает Клод по правилам');
  L.push('> `skills/threads-research/SKILL.md`, спорное — владелец.');
  L.push('');

  L.push('## Чек-лист');
  L.push('');
  for (const c of res.checklist) L.push(`- ${c.q} — **${c.status}**`);
  L.push('');

  if (res.agreement.length) {
    L.push('## Сходятся ли цифры');
    L.push('');
    L.push('| Число из утверждения | Подтвердили | Не нашлось на |');
    L.push('|---|---|---|');
    for (const a of res.agreement) {
      L.push(`| ${a.number} | ${a.confirmedBy.join(', ') || '— НИКТО' } | ${a.notFoundOn.join(', ') || '—'} |`);
    }
    L.push('');
  }

  L.push('## По ссылкам');
  L.push('');
  for (const r of res.reports) {
    L.push(`### ${r.host || r.url}`);
    L.push(`- адрес: ${r.url}`);
    if (!r.ok) {
      L.push(`- **не открылась:** ${r.error}`);
      r.questions.forEach((q) => L.push(`- ❓ ${q}`));
      L.push('');
      continue;
    }
    L.push(`- заголовок: ${r.title || '(нет)'}`);
    L.push(`- дата: ${r.publishedAt ? `${r.publishedAt} (${r.ageDays} дн. назад)` : '**НЕ НАЙДЕНА**'}`);
    if (r.dates.length > 1) L.push(`- все найденные даты: ${r.dates.slice(0, 4).map((d) => `${d.iso.slice(0, 10)} (${d.where})`).join('; ')}`);
    L.push(`- признаки: **${r.verdictHint}**`);
    if (r.primaryMarkers.length) L.push(`- маркеры первоисточника: ${r.primaryMarkers.join(', ')}`);
    if (r.reprintMarkers.length) L.push(`- маркеры перепечатки: ${r.reprintMarkers.join(', ')}`);
    if (r.claimNumbersFound.length) L.push(`- цифры из утверждения НАЙДЕНЫ: ${r.claimNumbersFound.join(', ')}`);
    if (r.claimNumbersMissing.length) L.push(`- цифры из утверждения НЕ найдены: ${r.claimNumbersMissing.join(', ')}`);
    if (r.outbound.length) L.push(`- ссылается на: ${r.outbound.map((o) => o.host).join(', ')}`);
    r.signals.forEach((s) => L.push(`- ⚠️ ${s}`));
    r.questions.forEach((q) => L.push(`- ❓ ${q}`));
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('**Правила, которые нельзя обойти:**');
  L.push('1. Нет первоисточника — факт в пост не идёт.');
  L.push('2. Нет даты — факт в пост не идёт.');
  L.push('3. Перепечатка источником не считается, даже если её открыли 10 раз.');
  L.push('4. Не подтвердилось — тема отбрасывается. Обтекаемо переписать нельзя.');
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `
verify.mjs — помощник проверки факта (не детектор правды).

  node lib/research/verify.mjs "<утверждение>" <url> [<url> ...]
  node lib/research/verify.mjs --claim "<утверждение>" --url <url> [--url <url>]

  --cited-domain <домен>  кого, по словам текста, цитируют (напр. who.int):
                          покажет, первоисточник это или мостик к нему
  --json                  выдать JSON

Пример:
  node lib/research/verify.mjs "Threads вырос до 150 млн активных в день" \\
    https://example.com/news https://about.fb.com/news/...
`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  let claim = '';
  const urls = [];
  let json = false;
  let citedDomain = '';

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--claim') claim = argv[++i] || '';
    else if (t === '--url') urls.push(argv[++i]);
    else if (t === '--cited-domain') citedDomain = argv[++i] || '';
    else if (t === '--json') json = true;
    else if (/^https?:\/\//i.test(t)) urls.push(t);
    else if (!claim) claim = t;
  }

  if (!urls.length) {
    throw new Error(
      'Не задано ни одной ссылки. Проверять факт без источника нельзя — в этом весь смысл.\n' + HELP
    );
  }

  const res = await verify(claim, urls, { citedDomain });
  if (json) console.log(JSON.stringify(res, null, 2));
  else console.log(toMarkdown(res));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('Ошибка: ' + e.message);
    process.exit(1);
  });
}
