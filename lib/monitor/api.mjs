/**
 * Клиент официального Threads API (graph.threads.net/v1.0).
 *
 * Чистый Node.js, ESM, БЕЗ npm-зависимостей: используется встроенный fetch
 * (Node 18+; проверено на Node 22 и 24).
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО ЗДЕСЬ НЕТ
 *
 * Есть только то, что Meta разрешает официально:
 *   keywordSearch()      — поиск по ЧУЖИМ публичным постам
 *   publishPost()        — свой пост (двухшаговая публикация)
 *   publishReply()       — ответ на пост (тот же механизм + reply_to_id)
 *   getReplies()         — ответы к своим постам
 *   getInsights()        — СВОИ метрики (чужие API не отдаёт вообще)
 *   getPublishingLimit() — сколько постов/ответов осталось в окне 24ч
 *
 * Нет и не будет: скрейпинга страниц, приватного API, RSS, чужих метрик,
 * автофоллоу, обхода rate limit. Причины — docs/api-facts.md.
 *
 * ТОКЕН
 * Только из переменной окружения THREADS_ACCESS_TOKEN. Никогда не хардкодится,
 * никогда не попадает в логи и в тексты ошибок: перед выводом любой строки
 * прогоняется scrubToken().
 *
 * КВОТЫ
 * Расход считается локально в файле состояния (state/quota.json), потому что
 * API не отдаёт остаток по keyword_search. Счётчик — это оценка, а не истина:
 * при расхождении верить ответу API (getPublishingLimit) и ошибке 429.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API_BASE = 'https://graph.threads.net/v1.0';

/** Официальные лимиты площадки. Меняются только вслед за документацией Meta. */
export const ЛИМИТЫ_API = {
  keywordSearchЗа24ч: 2200, // пустые результаты квоту не тратят
  постовЗа24ч: 250,
  ответовЗа24ч: 1000,
  удаленийЗа24ч: 100,
  окноСек: 86400,
  лимитПоискаНаЗапрос: 100,
};

// ───────────────────────────── ошибки ─────────────────────────────
//
// Три класса разведены намеренно: вызывающий код реагирует на них по-разному.
//   ОшибкаТокена  — работать нельзя вообще, нужен человек (перевыпуск токена)
//   ОшибкаЛимита   — подождать и повторить позже, это норма
//   ОшибкаAPI      — всё остальное; для стоп-крана это «необычный ответ»

export class ОшибкаAPI extends Error {
  constructor(сообщение, { статус = null, код = null, подтип = null, тело = null } = {}) {
    super(сообщение);
    this.name = 'ОшибкаAPI';
    this.статус = статус;
    this.код = код;
    this.подтип = подтип;
    this.тело = тело;
  }
}

/** Токен истёк, отозван или не имеет нужного скоупа. Автоматика бессильна. */
export class ОшибкаТокена extends ОшибкаAPI {
  constructor(сообщение, детали) {
    super(сообщение, детали);
    this.name = 'ОшибкаТокена';
  }
}

/** Превышен rate limit. Не повод для паники и не повод для стоп-крана. */
export class ОшибкаЛимита extends ОшибкаAPI {
  constructor(сообщение, детали = {}) {
    super(сообщение, детали);
    this.name = 'ОшибкаЛимита';
    this.повторитьЧерезСек = детали.повторитьЧерезСек ?? null;
  }
}

// ───────────────────────── защита токена в логах ─────────────────────────

/**
 * Вырезает из строки всё, что похоже на токен.
 * Вызывать ОБЯЗАТЕЛЬНО перед любым выводом текста, пришедшего от API,
 * и перед любым текстом ошибки: URL запроса содержит access_token.
 */
export function scrubToken(текст) {
  if (текст == null) return текст;
  let s = String(текст);
  // 1. Значение из окружения — самое точное совпадение.
  const живой = process.env.THREADS_ACCESS_TOKEN;
  if (живой && живой.length > 8) s = s.split(живой).join('«ТОКЕН-СКРЫТ»');
  // 2. Параметр в URL и в теле запроса.
  s = s.replace(/access_token=[^&\s"']+/gi, 'access_token=«ТОКЕН-СКРЫТ»');
  s = s.replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"«ТОКЕН-СКРЫТ»"');
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-]{12,}/gi, 'Bearer «ТОКЕН-СКРЫТ»');
  // 3. Длинные токеноподобные строки Meta (начинаются с THAA / EAA / IGAA).
  s = s.replace(/\b(THAA|EAA[A-Z]?|IGAA)[A-Za-z0-9._\-]{16,}/g, '«ТОКЕН-СКРЫТ»');
  return s;
}

// ───────────────────────── состояние квот ─────────────────────────

function читатьJSON(путь, поУмолчанию) {
  try {
    return JSON.parse(readFileSync(путь, 'utf8'));
  } catch {
    return поУмолчанию;
  }
}

/** Атомарная запись: пишем в .tmp и переименовываем, чтобы не оставить огрызок. */
function писатьJSON(путь, данные) {
  mkdirSync(dirname(путь), { recursive: true });
  const врем = `${путь}.tmp`;
  writeFileSync(врем, JSON.stringify(данные, null, 2), 'utf8');
  renameSync(врем, путь);
}

/**
 * Счётчик расхода квот в скользящем окне 24 часа.
 *
 * Хранит массив меток времени по каждому виду действия. Реализовано именно
 * скользящим окном, а не «счётчиком за календарные сутки»: Meta считает
 * окном 86400 секунд от каждого запроса, и сброс в полночь дал бы всплеск
 * активности сразу после полуночи — ровно то поведение, за которое банят.
 */
export class СчётчикКвот {
  constructor(путьФайла = 'state/quota.json') {
    this.путь = resolve(путьФайла);
    this.данные = читатьJSON(this.путь, { версия: 1, действия: {} });
    if (!this.данные.действия) this.данные.действия = {};
  }

  /** Убирает метки, вышедшие из окна. */
  _подрезать(вид, сейчас) {
    const порог = сейчас - ЛИМИТЫ_API.окноСек * 1000;
    const метки = (this.данные.действия[вид] || []).filter((t) => t > порог);
    this.данные.действия[вид] = метки;
    return метки;
  }

  /** Сколько действий этого вида уже израсходовано в окне. */
  израсходовано(вид, сейчас = Date.now()) {
    return this._подрезать(вид, сейчас).length;
  }

  /** Сколько осталось до официального лимита площадки. */
  осталось(вид, лимит, сейчас = Date.now()) {
    return Math.max(0, лимит - this.израсходовано(вид, сейчас));
  }

  /** Отметить состоявшееся действие и сразу сохранить. */
  отметить(вид, сейчас = Date.now()) {
    this._подрезать(вид, сейчас);
    this.данные.действия[вид].push(сейчас);
    this.сохранить();
    return this.данные.действия[вид].length;
  }

  /** Когда освободится место, если квота вида исчерпана (мс эпохи) или null. */
  когдаОсвободится(вид, лимит, сейчас = Date.now()) {
    const метки = this._подрезать(вид, сейчас);
    if (метки.length < лимит) return null;
    // Освободится, когда из окна выпадет метка, стоящая на месте лимита.
    const индекс = Math.max(0, метки.length - лимит);
    return метки[индекс] + ЛИМИТЫ_API.окноСек * 1000;
  }

  сохранить() {
    писатьJSON(this.путь, this.данные);
  }
}

// ───────────────────────── низкий уровень ─────────────────────────

const сон = (мс) => new Promise((r) => setTimeout(r, мс));

function взятьТокен(явный) {
  const t = явный || process.env.THREADS_ACCESS_TOKEN;
  if (!t) {
    throw new ОшибкаТокена(
      'Нет токена доступа. Положите его в переменную окружения ' +
        'THREADS_ACCESS_TOKEN (как получить — config/README.md). ' +
        'В файлы репозитория токен не записывать.',
    );
  }
  return t;
}

/**
 * Разбирает ответ Meta и превращает его в одну из трёх ошибок.
 *
 * Коды, которые нас интересуют (docs/api-facts.md):
 *   190      — токен недействителен/истёк/отозван
 *   102      — сессия не прошла проверку
 *   4, 17, 32, 613 — разные виды rate limit
 *   80007    — лимит публикации Threads
 *   его подтип 463 — токен просрочен
 */
function классифицировать(статус, тело, текстТела) {
  const ошибка = тело?.error || {};
  const код = ошибка.code ?? null;
  const подтип = ошибка.error_subcode ?? null;
  const сообщениеMeta = scrubToken(ошибка.message || текстТела || '(пустой ответ)');

  const детали = { статус, код, подтип, тело: scrubToken(текстТела) };

  const этоТокен =
    код === 190 ||
    код === 102 ||
    подтип === 463 ||
    подтип === 467 ||
    статус === 401 ||
    /access token|token.*expire|session.*invalid|OAuth/i.test(сообщениеMeta);

  if (этоТокен) {
    return new ОшибкаТокена(
      `Токен доступа не принят Threads (HTTP ${статус}, код ${код}). ` +
        `Ответ площадки: ${сообщениеMeta}. ` +
        'Это значит, что токен истёк, был отозван или у него нет нужного скоупа. ' +
        'Автоматика здесь бессильна: нужен человек — перевыпустить токен, ' +
        'шаги в config/README.md.',
      детали,
    );
  }

  const этоЛимит =
    статус === 429 ||
    код === 4 ||
    код === 17 ||
    код === 32 ||
    код === 613 ||
    код === 80007 ||
    /rate limit|too many|limit reached|calls to this api/i.test(сообщениеMeta);

  if (этоЛимит) {
    return new ОшибкаЛимита(
      `Превышен лимит запросов Threads (HTTP ${статус}, код ${код}). ` +
        `Ответ площадки: ${сообщениеMeta}. ` +
        'Это ожидаемая ситуация, а не поломка: нужно подождать и повторить позже.',
      детали,
    );
  }

  return new ОшибкаAPI(
    `Threads вернул ошибку (HTTP ${статус}, код ${код ?? 'нет'}). ` +
      `Ответ площадки: ${сообщениеMeta}`,
    детали,
  );
}

/**
 * Один запрос к API с экспоненциальным бэкоффом на 429 и 5xx.
 *
 * Бэкофф с разбросом (jitter): без разброса несколько параллельных повторов
 * возвращаются одновременно и снова получают 429.
 *
 * ВАЖНО: 4xx кроме 429 не повторяются никогда. Повторять запрос, который
 * площадка отвергла по смыслу, — способ получить блокировку.
 */
async function запрос(
  путь,
  {
    метод = 'GET',
    параметры = {},
    токен,
    попыток = 4,
    базоваяПаузаМс = 1000,
    fetchImpl = globalThis.fetch,
    сонImpl = сон,
    журнал = null,
  } = {},
) {
  const t = взятьТокен(токен);
  const url = new URL(`${API_BASE}${путь.startsWith('/') ? путь : `/${путь}`}`);

  const тело = {};
  for (const [k, v] of Object.entries(параметры)) {
    if (v === undefined || v === null || v === '') continue;
    if (метод === 'GET') url.searchParams.set(k, String(v));
    else тело[k] = String(v);
  }

  let последняя = null;

  for (let попытка = 1; попытка <= попыток; попытка++) {
    let ответ;
    let текст = '';
    try {
      const опции = {
        method: метод,
        headers: { Authorization: `Bearer ${t}` },
      };
      if (метод !== 'GET') {
        опции.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        опции.body = new URLSearchParams(тело).toString();
      }
      ответ = await fetchImpl(url.toString(), опции);
      текст = await ответ.text();
    } catch (e) {
      // Сеть не ответила. Это не ответ площадки — повторяем.
      последняя = new ОшибкаAPI(
        `Сеть недоступна при запросе к Threads: ${scrubToken(e?.message || e)}`,
        { статус: null },
      );
      if (попытка < попыток) {
        await сонImpl(пауза(базоваяПаузаМс, попытка));
        continue;
      }
      throw последняя;
    }

    let разобрано = null;
    try {
      разобрано = текст ? JSON.parse(текст) : {};
    } catch {
      разобрано = null;
    }

    if (ответ.ok && разобрано && !разобрано.error) return разобрано;

    if (ответ.ok && разобрано === null) {
      throw new ОшибкаAPI(
        'Threads ответил не-JSON при успешном статусе. Это признак того, ' +
          'что запрос ушёл не на тот адрес (например, на веб-страницу вместо API). ' +
          `Начало ответа: ${scrubToken(текст).slice(0, 200)}`,
        { статус: ответ.status, тело: scrubToken(текст).slice(0, 500) },
      );
    }

    const ошибка = классифицировать(ответ.status, разобрано, текст);
    последняя = ошибка;

    const можноПовторить =
      ошибка instanceof ОшибкаЛимита || (ответ.status >= 500 && ответ.status < 600);

    if (!можноПовторить || попытка === попыток) throw ошибка;

    // Retry-After площадки уважаем, если он есть и разумен.
    const retryAfter = Number(ответ.headers?.get?.('retry-after'));
    const задержка =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 300000)
        : пауза(базоваяПаузаМс, попытка);

    if (журнал) {
      журнал({
        событие: 'повтор_запроса',
        путь,
        попытка,
        статус: ответ.status,
        задержкаМс: задержка,
      });
    }
    await сонImpl(задержка);
  }

  throw последняя ?? new ОшибкаAPI('Запрос к Threads не удался без ответа.');
}

/** Экспоненциальная пауза с разбросом ±25%. */
function пауза(база, попытка) {
  const экспонента = база * 2 ** (попытка - 1);
  const разброс = экспонента * 0.25;
  return Math.round(экспонента - разброс + Math.random() * разброс * 2);
}

// ───────────────────────── публичный интерфейс ─────────────────────────

/**
 * Клиент API. Один экземпляр на процесс.
 *
 * @param {object} опции
 * @param {string} [опции.токен]        по умолчанию из THREADS_ACCESS_TOKEN
 * @param {string} [опции.userId]       'me' работает для большинства вызовов
 * @param {СчётчикКвот} [опции.квоты]
 * @param {function} [опции.fetchImpl]  подменяется в тестах
 * @param {function} [опции.журнал]     функция записи события
 */
export class КлиентThreads {
  constructor({
    токен,
    userId = 'me',
    квоты = null,
    fetchImpl = globalThis.fetch,
    сонImpl = сон,
    журнал = null,
    путьКвот = 'state/quota.json',
  } = {}) {
    // Токен не сохраняем в перечисляемое свойство, чтобы он не всплыл
    // в console.log(клиент) или в JSON.stringify(клиент).
    Object.defineProperty(this, '_токен', {
      value: токен || process.env.THREADS_ACCESS_TOKEN || null,
      enumerable: false,
      writable: false,
    });
    this.userId = userId;
    this.квоты = квоты || new СчётчикКвот(путьКвот);
    this._fetch = fetchImpl;
    this._сон = сонImpl;
    this._журнал = журнал;
  }

  /** Явно закрываем сериализацию: токен не должен утечь через логгер. */
  toJSON() {
    return { userId: this.userId, токен: '«ТОКЕН-СКРЫТ»' };
  }

  _опции(доп = {}) {
    return {
      токен: this._токен,
      fetchImpl: this._fetch,
      сонImpl: this._сон,
      журнал: this._журнал,
      ...доп,
    };
  }

  /**
   * Поиск по ЧУЖИМ публичным постам.
   * GET /v1.0/keyword_search
   *
   * Лимит 2200 запросов/24ч. Пустые результаты квоту не тратят — поэтому
   * счётчик увеличивается ТОЛЬКО когда что-то нашлось.
   *
   * ⚠️ Без одобренного скоупа threads_keyword_search поиск молча идёт только
   * по СВОИМ постам: ответ формально валиден, но чужих постов в нём нет.
   * Отличить это от «просто ничего не нашлось» по ответу невозможно —
   * проверяется глазами один раз после App Review.
   *
   * ⚠️ Поле owner из ответов вырезано Meta. Автора берём из author_username,
   * если он пришёл; закладываться на его наличие нельзя.
   * ⚠️ Чувствительные ключевые слова возвращают пустой массив без ошибки.
   */
  async keywordSearch({
    q,
    searchMode = 'KEYWORD',
    searchType = 'RECENT',
    mediaType,
    since,
    until,
    authorUsername,
    limit = 25,
    fields = 'id,text,username,permalink,timestamp,media_type,has_replies,is_quote_post',
  } = {}) {
    if (!q || !String(q).trim()) {
      throw new ОшибкаAPI('keywordSearch: не задана поисковая фраза (q).');
    }
    const лимитШт = Math.min(Math.max(1, Number(limit) || 25), ЛИМИТЫ_API.лимитПоискаНаЗапрос);

    const оставшиеся = this.квоты.осталось('search', ЛИМИТЫ_API.keywordSearchЗа24ч);
    if (оставшиеся <= 0) {
      throw new ОшибкаЛимита(
        `Исчерпан суточный лимит поиска (${ЛИМИТЫ_API.keywordSearchЗа24ч} запросов/24ч). ` +
          'Нужно подождать, пока освободится окно.',
      );
    }

    const ответ = await запрос('/keyword_search', this._опции({
      параметры: {
        q,
        search_mode: searchMode,
        search_type: searchType,
        media_type: mediaType,
        since,
        until,
        author_username: authorUsername,
        limit: лимитШт,
        fields,
      },
    }));

    const данные = Array.isArray(ответ?.data) ? ответ.data : [];
    // Пустой результат квоту не тратит — так задокументировано у Meta.
    if (данные.length > 0) this.квоты.отметить('search');

    return { посты: данные, пагинация: ответ?.paging ?? null, пустой: данные.length === 0 };
  }

  /**
   * Публикация своего поста. Двухшаговая модель Meta:
   *   1. POST /me/threads          → creation_id
   *   2. POST /me/threads_publish  → id опубликованного поста
   * Скоуп threads_content_publish.
   */
  async publishPost({ text, replyControl, topicTag } = {}) {
    if (!text || !String(text).trim()) {
      throw new ОшибкаAPI('publishPost: пустой текст поста.');
    }
    const осталось = this.квоты.осталось('post', ЛИМИТЫ_API.постовЗа24ч);
    if (осталось <= 0) {
      throw new ОшибкаЛимита(
        `Исчерпан суточный лимит постов площадки (${ЛИМИТЫ_API.постовЗа24ч}/24ч).`,
      );
    }

    const черновик = await запрос(`/${this.userId}/threads`, this._опции({
      метод: 'POST',
      параметры: {
        media_type: 'TEXT',
        text,
        reply_control: replyControl,
        topic_tag: topicTag,
      },
    }));
    if (!черновик?.id) {
      throw new ОшибкаAPI('Threads не вернул creation_id при создании черновика поста.');
    }

    const опубликован = await запрос(`/${this.userId}/threads_publish`, this._опции({
      метод: 'POST',
      параметры: { creation_id: черновик.id },
    }));

    this.квоты.отметить('post');
    return { id: опубликован?.id ?? null, creationId: черновик.id };
  }

  /**
   * Ответ на пост (свой или чужой).
   *
   * Тот же двухшаговый механизм + reply_to_id. Разрешено, если вы владелец
   * корневого поста ЛИБО одобрен скоуп threads_keyword_search /
   * threads_manage_mentions.
   *
   * ⚠️ Этот метод НЕ содержит предохранителей. Вызывать только через
   * lib/monitor/guardrails.mjs → Предохранители.проверитьОтвет().
   * Прямой вызов в цикле — самый короткий путь к блокировке аккаунта.
   */
  async publishReply({ text, replyToId } = {}) {
    if (!text || !String(text).trim()) {
      throw new ОшибкаAPI('publishReply: пустой текст ответа.');
    }
    if (!replyToId) {
      throw new ОшибкаAPI('publishReply: не указан reply_to_id — на какой пост отвечаем.');
    }
    const осталось = this.квоты.осталось('reply', ЛИМИТЫ_API.ответовЗа24ч);
    if (осталось <= 0) {
      throw new ОшибкаЛимита(
        `Исчерпан суточный лимит ответов площадки (${ЛИМИТЫ_API.ответовЗа24ч}/24ч).`,
      );
    }

    const черновик = await запрос(`/${this.userId}/threads`, this._опции({
      метод: 'POST',
      параметры: { media_type: 'TEXT', text, reply_to_id: replyToId },
    }));
    if (!черновик?.id) {
      throw new ОшибкаAPI('Threads не вернул creation_id при создании черновика ответа.');
    }

    const опубликован = await запрос(`/${this.userId}/threads_publish`, this._опции({
      метод: 'POST',
      параметры: { creation_id: черновик.id },
    }));

    this.квоты.отметить('reply');
    return { id: опубликован?.id ?? null, creationId: черновик.id, replyToId };
  }

  /**
   * Ответы к своему посту (mediaId) или ко всем своим постам (без mediaId).
   * GET /{threads-media-id}/replies | GET /{threads-user-id}/replies
   */
  async getReplies({
    mediaId,
    reverse = false,
    fields = 'id,text,username,timestamp,permalink,is_reply,replied_to,root_post,reply_audience,has_replies',
    limit = 25,
  } = {}) {
    const путь = mediaId ? `/${mediaId}/replies` : `/${this.userId}/replies`;
    const ответ = await запрос(путь, this._опции({
      параметры: { fields, limit, reverse: reverse ? 'true' : undefined },
    }));
    return { ответы: Array.isArray(ответ?.data) ? ответ.data : [], пагинация: ответ?.paging ?? null };
  }

  /**
   * СВОИ метрики. Скоуп threads_manage_insights.
   *
   * ⚠️ Чужие метрики API не отдаёт ни в каком виде — это не обходится.
   * ⚠️ Вложенные ответы в метрики не попадают.
   * ⚠️ since/until не работают для дат до 13.04.2024.
   * ⚠️ follower_demographics требует ≥100 подписчиков, иначе ошибка.
   *
   * @param {string} [mediaId] пост; без него — метрики аккаунта
   */
  async getInsights({ mediaId, metrics, since, until } = {}) {
    const поПосту = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];
    const поАккаунту = [...поПосту, 'clicks', 'followers_count'];
    const набор = metrics || (mediaId ? поПосту : поАккаунту);

    const РУБЕЖ = Date.UTC(2024, 3, 13) / 1000; // 13.04.2024, раньше API не умеет
    for (const [имя, знач] of [['since', since], ['until', until]]) {
      if (знач && Number(знач) < РУБЕЖ) {
        throw new ОшибкаAPI(
          `getInsights: ${имя}=${знач} раньше 13.04.2024. Threads для таких дат ` +
            'метрики не отдаёт — возьмите более позднюю дату.',
        );
      }
    }

    const путь = mediaId ? `/${mediaId}/insights` : `/${this.userId}/threads_insights`;
    const ответ = await запрос(путь, this._опции({
      параметры: { metric: (Array.isArray(набор) ? набор : [набор]).join(','), since, until },
    }));

    // Приводим к плоскому виду: {views: 123, likes: 4}
    const плоско = {};
    for (const м of ответ?.data ?? []) {
      плоско[м.name] = м.total_value?.value ?? м.values?.[0]?.value ?? null;
    }
    return { метрики: плоско, сырое: ответ?.data ?? [] };
  }

  /**
   * Остаток лимитов публикации по данным САМОЙ площадки.
   * GET /{threads-user-id}/threads_publishing_limit
   *
   * Это источник истины. Локальный счётчик — только оценка: если числа
   * расходятся, верить этому ответу.
   */
  async getPublishingLimit() {
    const ответ = await запрос(`/${this.userId}/threads_publishing_limit`, this._опции({
      параметры: {
        fields: 'quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config',
      },
    }));
    const d = ответ?.data?.[0] ?? {};
    return {
      постовИспользовано: d.quota_usage ?? null,
      постовВсего: d.config?.quota_total ?? ЛИМИТЫ_API.постовЗа24ч,
      ответовИспользовано: d.reply_quota_usage ?? null,
      ответовВсего: d.reply_config?.quota_total ?? ЛИМИТЫ_API.ответовЗа24ч,
      удаленийИспользовано: d.delete_quota_usage ?? null,
      удаленийВсего: d.delete_config?.quota_total ?? ЛИМИТЫ_API.удаленийЗа24ч,
      сырое: d,
    };
  }
}

export const _внутреннее = { запрос, пауза, классифицировать, взятьТокен };
export default КлиентThreads;
