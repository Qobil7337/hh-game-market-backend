# hh-game-market-backend

Ключевые решения и как это масштабировать — в [DECISIONS.md](DECISIONS.md).

**Стек:** Node.js 24 · NestJS 12 (ESM) на Fastify · TypeORM · PostgreSQL · Vitest.
Никаких очередей и Redis: очередь — сама таблица `orders` (`SELECT … FOR UPDATE
SKIP LOCKED`).

## Быстрый старт

Нужны Node.js ≥ 22 и PostgreSQL (любой, локальный или в Docker).

```bash
cd backend
cp .env.example .env        # поправьте DB_* под свою базу
npm install
npm run start:dev           # http://localhost:3000/api
```

Схема создаётся автоматически (`synchronize`), каталог и пул ключей из
приложения к заданию засеваются при старте (идемпотентно). Поставщики-заглушки
и заглушка платёжки живут в этом же процессе, но воркер ходит к ним по HTTP —
таймауты настоящие.

> База осталась от первого этапа? Во втором заказ разбит на позиции, и у
> старых строк `deliveries` / `delivery_attempts` нет `order_item_id` —
> `synchronize` не сможет добавить обязательную колонку. Очистите таблицы
> заказов (`TRUNCATE orders, payment_events, deliveries, delivery_attempts,
> ledger_entries CASCADE`) или пересоздайте базу.

```bash
curl http://localhost:3000/api/health
# {"status":"ok","database":"up"}
```

## Тесты

```bash
cd backend
npm test
```

> Тесты поднимают приложение целиком на случайном порту, **очищают
> сконфигурированную базу** (`TRUNCATE`) и засевают её заново. Не запускайте
> их против базы с нужными данными.

47 e2e-тестов в `backend/test/`:

| Файл | Что проверяет |
| --- | --- |
| `orders.e2e-spec.ts` | этап 1: жизненный цикл, `payment_failed`, дубль `event_id`, событие для неизвестного заказа, несовпадение суммы |
| `races.e2e-spec.ts` | этап 2: **два экземпляра приложения на одной базе**; 50 повторов одного `event_id`, 50 разных `event_id` на один заказ, гонка paid/failed, события не по порядку, 20 заказов × 5 вебхуков разом |
| `suppliers.e2e-spec.ts` | этап 3: ловушка таймаута, неразрешённый таймаут не уходит на fallback, 5xx → B, недоступный A → B, пустой остаток → возврат, хаос-тест на обоих поставщиках (≤ 1 ключа на заказ) |
| `recovery.e2e-spec.ts` | этап 4: зависший `delivering`, повтор запаркованных заказов, сверка, журнал сходится |
| `catalog.e2e-spec.ts` | этап 5: витрина с keyset-пагинацией, списание остатка, план запроса на 5 000 SKU идёт по индексу |
| `multi-item.e2e-spec.ts` | **второе задание, задача 1**: три позиции от двух поставщиков; одна позиция не выдаётся → возврат, остальное у покупателя; ничего не выдаётся → полный возврат; воркер умер между позициями → recovery дожимает без второго кода; платёжка отвергла возврат → повтор платит ровно один раз; хаос на 12 заказов × 3 позиции — у каждого заказа оплачено = выдано + возвращено |
| `untrusted.e2e-spec.ts` | **второе задание, задача 2**: поставщик прислал чужой (уже выданный) код → отклонён, три новых `request_id`, затем запасной поставщик; в ответе один код, в книге другой → выдан тот, что в книге; 5xx после выдачи → код взят из книги, второго запроса нет; аудит книги находит то, чего проход не видел, и ровно один раз; хаос с ложью, 5xx и зависаниями на обоих — каждый выданный код есть в книге, ни один не выдан дважды |
| `burst.e2e-spec.ts` | **второе задание, задача 3**: 12 заказов при лимите 4 запроса / 2 с — очередь видна, всё выдано, поставщик не отклонил ни одного запроса и не видел больше лимита в окне; оплаченные выдаются в порядке оплаты, неоплаченные к поставщику не ходят; лимит A не тормозит заказы B; заказ в очереди переживает рестарт — его забирает второй экземпляр |
| `history.e2e-spec.ts` | **второе задание, задача 4**: заказ восстанавливается на момент каждого события своей жизни (до создания — 404, после оплаты — всё в долге, после первой позиции — половина, сейчас — как живой заказ); `UPDATE`/`DELETE` по истории и журналу отвергаются базой, recovery и `/deliver` тоже пишут историю; деньги на момент и за период считаются из истории, половины периода складываются в целое, каждый период сходится с открывающим и закрывающим балансом и с событиями |

Каждый тест заканчивается проверкой инвариантов прямо в базе
(`expectConsistent` в `test/helpers.ts`): число выдач = число выданных позиций
= число уникальных кодов; каждый выданный код записан в книге поставщика под
нашим `request_id`, а каждая запись книги без выдачи объяснена расхождением;
число возвратов = число возвращённых позиций = число возвратов на стороне
платёжки; для каждого оплаченного заказа оплачено = выдано + возвращено + ещё
открыто, у финальных открытого нет; журнал сходится в ноль.

## Как воспроизвести проверки

Все команды — из `backend/` при запущенном `npm run start:dev`. Скрипты
зависят только от Node.js (встроенный `fetch`).

### Гонки (этап 2)

```bash
npm run pay                     # один вебхук "paid" на новый заказ
npm run race                    # 50 параллельных повторов одного event_id
npm run race -- --distinct      # 50 разных event_id на один заказ
npm run pay -- --status failed  # событие "failed"
npm run pay -- --order <id>     # вебхук на существующий заказ (не по порядку / позже финала)
```

Скрипт печатает, что ответил API на каждый вебхук, и финальный статус:

```
50 webhook(s) in 83ms: { applied: 1, duplicate: 49 }
final status=delivered  code=0K9E-P1FR-BY1U  supplier=a
```

### Отказ и fallback поставщика (этап 3)

```bash
npm run stub -- a --error-rate 1          # A всегда отвечает 5xx
npm run pay                               # → 3 попытки к A, выдача от B

npm run stub -- a --reset --timeout-rate 1 --hang-ms 8000
npm run pay                               # A выдал код и завис (и книга A тоже висит) → delivery_failed, B не трогаем
curl http://localhost:3000/api/orders/<id>          # attempts: a:timeout ×4, delivery = null

npm run stub -- a --reset
curl -X POST http://localhost:3000/api/orders/<id>/deliver
curl http://localhost:3000/api/orders/<id>          # delivered, тот же код, что выдал A

npm run stub -- a --error-rate 0.4 --timeout-rate 0.3   # хаос-режим
npm run stub -- b --restock KEY-0000-0001,KEY-0000-0002  # пополнить пул B
npm run stub -- a                                        # статус и остаток пула
```

Пустой остаток: очистите пулы (`DELETE FROM supplier_keys WHERE request_id IS
NULL`) или объявите SKU недоступным (`npm run stub -- a --unavailable KEY-EFT`),
оплатите заказ — позиция, которую не выдал ни один поставщик, возвращается
(см. второе задание ниже).

### Сверка и восстановление (этап 4)

```bash
curl http://localhost:3000/api/admin/reconciliation   # "оплачен, но не выдан", "выдан, но не оплачен", журнал
curl -X POST http://localhost:3000/api/admin/recovery # прогнать восстановление сейчас
```

Фоновое восстановление и так идёт раз в `RECOVERY_INTERVAL_MS`: заказы,
застрявшие в `delivering` дольше `DELIVERY_STALE_AFTER_MS`, и запаркованные
(`delivery_failed`) старше `RECOVERY_RETRY_AFTER_MS` возвращаются в очередь.
Повторная выдача идемпотентна: уже выданные и возвращённые позиции
пропускаются, у остальных те же `request_id`, и поставщик, который ранее
ответил таймаутом, опрашивается первым.

Логи — по строке JSON на событие (`LOG_FORMAT=json`): `payment.webhook`,
`delivery.attempt`, `delivery.item_delivered`, `delivery.item_unresolved`,
`delivery.verify_failed`, `supplier.discrepancy`, `supplier.audit`,
`refund.completed`, `refund.failed`, `delivery.completed`, `delivery.queued`
(отложен лимитом), `delivery.parked`, `recovery.sweep`.

### Каталог под нагрузкой (этап 5)

```bash
curl -X POST http://localhost:3000/api/admin/catalog/generate \
     -H 'content-type: application/json' -d '{"count":100000}'
curl 'http://localhost:3000/api/products?type=key&limit=50'
curl 'http://localhost:3000/api/products?type=key&limit=50&cursor=GEN-KEY-0001234'
curl 'http://localhost:3000/api/admin/explain?type=key&limit=50'   # EXPLAIN (ANALYZE, BUFFERS)
```

## Второе задание

### Задача 1. Заказ из нескольких товаров, часть не выдаётся

Заказ состоит из позиций (`order_items`) — по одной на единицу товара. Каждая
позиция выдаётся своим поставщиком (`products.supplier`: пополнения и ключи —
A, подписки и подарочные карты — B; второй поставщик — запасной) и получает
свой код. Позиция, которую **определённо** не выдал никто (`out_of_stock` или
5xx у всех), возвращается через заглушку платёжки; позиция, по которой
поставщик молчит (таймаут после возможной выдачи), остаётся открытой, а заказ
паркуется в `delivery_failed` до повтора — возвращать деньги, пока поставщик
мог выдать код, нельзя.

**Частичный сбой:**

```bash
npm run stub -- a --unavailable KEY-EFT     # KEY-EFT нет ни у A…
npm run stub -- b --unavailable KEY-EFT     # …ни у B
npm run pay -- --sku KEY-GTA5,KEY-EFT,SUB-YT-3M
```

```
order 4f0e…  [KEY-GTA5, KEY-EFT, SUB-YT-3M]  6970 RUB  status=created
1 webhook(s) in 21ms: { applied: 1 }
final status=partially_delivered  money={"paid":6970,"delivered":3480,"refunded":3490,"pending":0}
  KEY-GTA5         delivered  code=LFXC-TNCS-BPCD supplier=a
  KEY-EFT          refunded   refunded 3490 (out_of_stock)
  SUB-YT-3M        delivered  code=FZXF-58H8-OR93 supplier=b
```

`GET /orders/:id` показывает по каждой позиции `delivery` или `refund`, а в
`money` — куда ушёл каждый рубль. `GET /stubs/payments` — что получила
платёжка (`refunds.count`, `refunds.amount`).

**Авария посреди выдачи.** B выдаёт код второй позиции и зависает; первая уже
у покупателя:

```bash
npm run stub -- a --reset; npm run stub -- b --reset --timeout-rate 1 --hang-ms 8000
npm run pay -- --sku KEY-GTA5,SUB-YT-3M     # → delivery_failed: items[0] delivered, items[1] pending
npm run stub -- b --reset
curl -X POST http://localhost:3000/api/orders/<id>/deliver
curl http://localhost:3000/api/orders/<id>  # delivered; вторая позиция получила код, который держал B
```

Убитый воркер оставляет ровно такое же состояние (`delivering`, часть позиций
выдана) — его подберёт `POST /admin/recovery` / фоновое восстановление. Отказ
платёжки на возврате: `npm run stub -- psp --error-rate 1` → позиция остаётся в
`refunding`, заказ в `delivery_failed`; после `--reset` повтор проводит возврат
один раз (`refund_id` = id позиции).

**Как проверить, что деньги сходятся:**

```bash
curl http://localhost:3000/api/admin/reconciliation
```

- `ledger.balanced` — балансы журнала совпадают с позициями: `cash` =
  оплачено − возвращено, `revenue` = выдано, `refunded` = возвращено,
  `customerLiability` = ещё открыто, `total` = 0;
- `moneyMismatches` — заказы, у которых оплачено ≠ выдано + возвращено +
  открыто (по позициям или по проводкам) либо финальный статус при открытых
  позициях; должно быть пусто;
- `healthy` — всё вместе.

Тот же инвариант для каждого заказа — в `money` из `GET /orders/:id`, и им же
заканчивается каждый e2e-тест (`expectConsistent`).

### Задача 2. Поставщик, которому нельзя доверять

Ответ поставщика — заявление, а не факт. Факты два: **книга поставщика**
(`GET /stubs/suppliers/{a|b}/issued?request_id=…` — что он записал под нашим
`request_id`; за это он и выставит счёт) и **наша таблица выдач** (`code UNIQUE`
— код выдаётся один раз). Код уходит покупателю только когда оба согласны;
каждое несогласие пишется в `supplier_discrepancies` вместе с тем, что с ним
сделали. Заглушка умеет врать тремя способами:

```bash
npm run stub -- a --reset --duplicate-rate 1         # A выдаёт уже выданные коды
npm run pay                                          # → 3 раунда с новыми request_id отклонены, выдал B
curl http://localhost:3000/api/orders/<id>           # attempts: a:ok, a:rejected ×3 …, b:ok; discrepancies: duplicate_code ×3

npm run stub -- a --reset --foreign-rate 1           # A записывает один код, отвечает другим
npm run pay                                          # → выдан код из книги; discrepancies: code_mismatch

npm run stub -- a --reset --error-after-issue-rate 1 # A записывает код и отвечает 5xx
npm run pay                                          # → 3 × a:error, код взят из книги, B не трогаем; discrepancies: error_but_issued

npm run stub -- a --reset --error-rate 1             # честный 5xx до выдачи
npm run pay                                          # → 3 × a:error, a:none_issued (книга пуста), b:ok
```

Что гарантирует каждое требование:

- **один код не попадёт в два заказа** — `deliveries.code UNIQUE`; при
  конфликте код отклоняется (`a:rejected`, `duplicate_code`), поставщика
  спрашивают заново под новым `request_id` (`<item>:<supplier>:2`, `:3`), после
  `SUPPLIER_MAX_ROUNDS` — запасной поставщик;
- **покупатель получает ровно один рабочий код** — перед выдачей ответ
  сверяется с книгой: расходится — выдаётся записанный (`code_mismatch`),
  в книге пусто — отклоняется (`unbooked_code`); и `order_item_id UNIQUE`;
- **ошибка, но код выдан → повтор не выдаёт второй** — после 5xx/таймаута,
  прежде чем уйти к другому поставщику или вернуть деньги, читается книга: есть
  код — берём его (`error_but_issued`), пусто после 5xx — `none_issued` и
  дальше, пусто сразу после таймаута — заказ паркуется (запрос мог ещё
  выполняться) и книга перечитывается на следующем проходе, недоступна —
  заказ паркуется до повтора;
- **расхождения находятся и разбираются сами** — всё выше происходит в момент
  выдачи; остальное (запись в книге под `request_id`, который мы не посылали
  или уже закрыли; код в книге поменялся после выдачи) находит аудит книги:
  `POST /admin/supplier-audit` или раз в `SUPPLIER_AUDIT_INTERVAL_MS`. Каждое
  расхождение записывается один раз с `resolution` — что сделано (код не
  использован, спор с поставщиком). Ручного шага нет.

```bash
curl -X POST http://localhost:3000/api/admin/supplier-audit   # {"checked":{"a":12,"b":3},"unreachable":[],"found":[…]}
curl http://localhost:3000/api/admin/reconciliation           # supplierDiscrepancies, supplierIssuesWithoutDelivery, supplierCodeMismatches
```

### Задача 3. Всплеск заказов и лимит поставщика

Лимит держится **у нас**, до вызова: `SUPPLIER_RATE_LIMIT` запросов на
поставщика в любое скользящее окно `SUPPLIER_RATE_WINDOW_MS`, счётчик — в
Postgres (`supplier_calls`), поэтому все экземпляры приложения тратят один
бюджет. Одна выдача стоит два запроса (issue + обязательная сверка с книгой)
и бронирует оба сразу. Нет слота — заказ **не ждёт в воркере**, а возвращается
в очередь: `paid` с `not_before` = момент, когда освободится слот, и с прежним
`paid_at`, то есть на своём месте. Очередь — по-прежнему таблица заказов,
поэтому ничего не теряется и при рестарте.

```bash
npm run stub -- a --reset --rate-limit 4 --rate-window-ms 2000   # A принимает 4 запроса за 2 с (сверх — 429)
# в backend/.env: SUPPLIER_A_RATE_LIMIT=4, SUPPLIER_RATE_WINDOW_MS=2000, затем перезапуск
for i in $(seq 1 12); do npm run pay -- --sku KEY-GTA5 > /dev/null & done; wait
curl http://localhost:3000/api/admin/queue
```

```json
{
  "orders": { "awaitingPayment": 0, "queued": 0, "waitingForSlot": 8, "delivering": 2, "delivered": 2, … },
  "items": { "open": 10, "delivered": 2, "refunded": 0 },
  "suppliers": { "a": { "limit": 4, "windowMs": 2000, "used": 4, "available": 0, "nextSlotInMs": 1730 }, "b": { … } }
}
```

Через несколько окон `delivered: 12`, а у заглушки
(`npm run stub -- a`) — `calls: { total: 24, rejected: 0, peakInWindow: 4 }`:
она сама считает, сколько запросов пришло и сколько было в одном окне —
это и есть проверка «лимит не превышен».

- **Ничего не теряется** — очередь в базе, не в памяти; заказ, отложенный
  лимитом, остаётся `paid` и будет забран любым экземпляром.
- **Лимит не превышается** — слот берётся до запроса, атомарно
  (`pg_advisory_xact_lock` на поставщика + счёт в окне), наше окно на 100 мс
  длиннее окна поставщика, чтобы дрожание сети не сблизило два запроса.
- **Оплаченные раньше неоплаченных** — к поставщику ходят только оплаченные
  заказы: неоплаченный (`created`) в очереди выдачи не существует и слот
  занять не может; среди оплаченных порядок — по `paid_at`, и отложенный
  лимитом заказ своё место не теряет. Фоновая работа (аудит книги) берёт
  только то, что осталось от выдач.
- **Прогресс** — `GET /admin/queue`: заказы по стадиям (`queued`,
  `waitingForSlot`, `delivering`, `delivered`, …), открытые позиции и
  использование лимита по каждому поставщику; лимит одного поставщика не
  задерживает заказы другого — отложенный заказ освобождает дорожку.

### Задача 4. Восстановление картины на любой момент

Две истории, обе только дополняются: `order_events` — каждое изменение
заказа и позиции, записанное **в той же транзакции**, что и само изменение
(это делает сам `transitionOrder()`/`transitionItem()`, так что пропустить
событие невозможно), и `ledger_entries` — журнал денег из первого этапа.
Триггер в базе отвергает `UPDATE` и `DELETE` по обеим таблицам.

```bash
curl http://localhost:3000/api/orders/<id>/history                      # все события заказа по порядку
curl 'http://localhost:3000/api/orders/<id>/at?time=2026-09-09T12:00:00Z' # заказ, каким он был в этот момент
curl 'http://localhost:3000/api/admin/money?at=2026-09-09T12:00:00Z'      # балансы на момент
curl 'http://localhost:3000/api/admin/money?from=2026-09-09T00:00:00Z&to=2026-09-10T00:00:00Z'  # итоги за период
```

```json
{ "at": "…", "status": "delivering", "amount": 5480,
  "items": [ { "sku": "KEY-GTA5", "status": "delivered", "delivery": { "code": "…", "supplier": "a" } },
             { "sku": "KEY-EFT",  "status": "pending",   "delivery": null, "refund": null } ],
  "money": { "paid": 5480, "delivered": 1990, "refunded": 0, "pending": 3490 }, "eventsApplied": 4 }
```

Состояние заказа — свёртка его событий до момента `time` (`order.created` →
позиции, дальше `order.status` / `item.status` с кодом, поставщиком, суммой и
причиной возврата). Деньги на момент — сумма проводок журнала до этого
момента. Итоги за период `[from, to)` — `moved` (оплачено, выдано,
возвращено и число операций) плюс `opening`/`closing` балансы, и два флага:
`balanced` — закрывающий баланс равен открывающему плюс движения,
`eventsAgree` — те же суммы и счётчики получаются из `order_events`. Пока
заказ не создан, `/at` отвечает 404; момент задаётся с точностью до
миллисекунды и включает всё, что записано в эту миллисекунду.

## API

Префикс `/api`. Тела — JSON.

| Метод и путь | Назначение |
| --- | --- |
| `GET /health` | приложение и база |
| `GET /products?type=&limit=&cursor=` | витрина: активные товары с остатком, keyset-пагинация по `sku` |
| `POST /orders` `{items: [{sku, quantity?}]}` или `{sku}` | создать заказ (цены фиксируются из каталога, одна позиция на единицу) → `201` |
| `GET /orders/:id` | заказ, позиции (`items[].delivery` / `items[].refund`), деньги (`money`), история обращений к поставщикам (`attempts`) и расхождения с ними (`discrepancies`) |
| `GET /orders/:id/history` | все события заказа, старые первыми |
| `GET /orders/:id/at?time=` | заказ на момент `time` (ISO 8601), восстановленный из событий |
| `POST /orders/:id/deliver` | повторная выдача для `delivery_failed` |
| `POST /webhooks/payment` | вебхук платёжки по контракту; всегда `200` после записи события |
| `POST /stubs/suppliers/{a\|b}/issue` | заглушка поставщика по контракту |
| `GET /stubs/suppliers/{a\|b}/issued?request_id=` | книга поставщика: запись под `request_id` (404, если нет) или вся выписка |
| `GET /stubs/suppliers/{a\|b}` | конфиг сбоев, остаток пула, статистика запросов (`calls`) |
| `PUT /stubs/suppliers/{a\|b}/config` `{errorRate, timeoutRate, hangMs, unavailableSkus, duplicateRate, foreignRate, errorAfterIssueRate, rateLimit, rateWindowMs}` | доля 5xx / зависаний / лжи (0..1), SKU «нет в наличии», лимит запросов в окно (сверх — 429); сбрасывает `calls` |
| `POST /stubs/suppliers/{a\|b}/keys` `{codes[]}` | пополнить пул |
| `POST /stubs/payments/refund` `{refund_id, order_id, amount, currency}` | заглушка платёжки: возврат, идемпотентный по `refund_id` |
| `GET /stubs/payments` | конфиг и сколько возвратов получила платёжка |
| `PUT /stubs/payments/config` `{errorRate}` | доля 5xx на возврат |
| `GET /admin/reconciliation` | сверка + балансы журнала + расхождения с поставщиками |
| `POST /admin/recovery` | прогнать восстановление сейчас |
| `POST /admin/supplier-audit` | сверить книги поставщиков с выдачами сейчас |
| `GET /admin/queue` | прогресс очереди: заказы по стадиям, открытые позиции, лимиты поставщиков |
| `GET /admin/money?at=` / `?from=&to=` | балансы на момент / итоги за период из журнала, сверенные с событиями |
| `PUT /admin/stock/:sku` `{available}` | выставить остаток на витрине |
| `POST /admin/catalog/generate` `{count}` | сгенерировать SKU для нагрузочных экспериментов |
| `GET /admin/explain?…` | план витринного запроса |

Ответ вебхука: `{"result": "applied" | "duplicate" | "order_not_found" |
"amount_mismatch" | "ignored_<статус заказа>"}` — то же значение пишется в
`payment_events.outcome`.

## Статусы заказа

```
created ──paid──▶ paid ──▶ delivering ──▶ delivered            все позиции выданы
   │                            ├──────▶ partially_delivered  часть выдана, остальное возвращено
   └──failed──▶ payment_failed  ├──────▶ refunded             ничего не выдано, всё возвращено
                                └──────▶ delivery_failed      есть открытые позиции; восстановимый:
                                                              /deliver или recovery → paid → …
```

Позиция (`items[].status`): `pending` → `delivered` | `refunding` → `refunded`.
`refunding` — решение о возврате уже записано, платёжке ещё не удалось его
провести. `paid` — это и есть очередь выдачи (по `paid_at`); заказ, отложенный
лимитом поставщика, возвращается в `paid` с `not_before`.

## Конфигурация (`backend/.env`)

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `PORT` | `3000` | |
| `DB_HOST` `DB_PORT` `DB_USERNAME` `DB_PASSWORD` `DB_DATABASE` | `localhost` `5432` `hh` `hh_dev_password` `hh_game_market` | |
| `LOG_FORMAT` | `json` | `json` — по строке JSON; иначе цветной вывод |
| `SUPPLIER_A_URL` `SUPPLIER_B_URL` | `http://localhost:3000/api/stubs/suppliers/{a,b}` | адреса поставщиков |
| `SUPPLIERS` | `a,b` | порядок обхода |
| `SUPPLIER_TIMEOUT_MS` | `3000` | таймаут одного запроса |
| `SUPPLIER_MAX_ATTEMPTS` | `3` | попыток на поставщика |
| `SUPPLIER_RETRY_BASE_MS` | `500` | база экспоненциального бэкоффа (500, 1000, …) |
| `SUPPLIER_MAX_ROUNDS` | `3` | новых `request_id` на поставщика после отклонённого кода |
| `SUPPLIER_AUDIT_INTERVAL_MS` | `60000` | период сверки книг поставщиков с выдачами |
| `SUPPLIER_RATE_LIMIT` `SUPPLIER_{A,B}_RATE_LIMIT` | `0` (без лимита) | наших запросов к поставщику в окно; на поставщика — приоритетнее общего |
| `SUPPLIER_RATE_WINDOW_MS` | `60000` | окно лимита |
| `DELIVERY_CONCURRENCY` | `4` | параллельных выдач в одном экземпляре |
| `DELIVERY_POLL_INTERVAL_MS` | `2000` | страховочный опрос очереди |
| `PSP_URL` `PSP_TIMEOUT_MS` | `http://localhost:3000/api/stubs/payments` `3000` | заглушка платёжки для возвратов |
| `RECOVERY_INTERVAL_MS` | `30000` | период восстановления |
| `DELIVERY_STALE_AFTER_MS` | `60000` | `delivering` старше — считаем зависшим |
| `RECOVERY_RETRY_AFTER_MS` | `60000` | пауза перед повтором запаркованных |
| `STUB_{A,B}_ERROR_RATE` `STUB_{A,B}_TIMEOUT_RATE` `STUB_HANG_MS` `STUB_PSP_ERROR_RATE` | `0` `0` `10000` `0` | стартовые настройки заглушек |
| `STUB_{A,B}_RATE_LIMIT` `STUB_RATE_WINDOW_MS` | `0` `60000` | сколько запросов в окно принимает заглушка поставщика (сверх — 429) |

## Структура

```
backend/src/
├── orders/      Order, OrderItem + статусы, transitionOrder()/transitionItem() (compare-and-set), POST/GET /orders
├── payments/    PaymentEvent (event_id — PK), обработчик вебхука
├── delivery/    Delivery, Refund, DeliveryAttempt, SupplierDiscrepancy, воркер (SKIP LOCKED), политика поставщиков, возвраты, recovery, аудит книг, лимит запросов (SupplierLimiter)
├── ledger/      двойная запись: cash / customer_liability / revenue (оплата, выдача, возврат)
├── history/     OrderEvent (append-only), состояние заказа на момент, деньги на момент и за период
├── catalog/     Product (+ supplier), ProductStock, витрина
├── admin/       сверка, прогресс очереди, recovery, аудит, генератор каталога, EXPLAIN
├── stubs/       заглушки: поставщики с инъекцией сбоев и лжи (+ их книга), платёжка (возвраты)
└── seed/        каталог и пул ключей из приложения к заданию
backend/test/    e2e-тесты (vitest)
backend/scripts/ pay.mjs — эмулятор вебхуков платёжки, stub.mjs — управление заглушками (a, b, psp)
```
