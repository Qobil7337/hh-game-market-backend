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

35 e2e-тестов в `backend/test/`:

| Файл | Что проверяет |
| --- | --- |
| `orders.e2e-spec.ts` | этап 1: жизненный цикл, `payment_failed`, дубль `event_id`, событие для неизвестного заказа, несовпадение суммы |
| `races.e2e-spec.ts` | этап 2: **два экземпляра приложения на одной базе**; 50 повторов одного `event_id`, 50 разных `event_id` на один заказ, гонка paid/failed, события не по порядку, 20 заказов × 5 вебхуков разом |
| `suppliers.e2e-spec.ts` | этап 3: ловушка таймаута, неразрешённый таймаут не уходит на fallback, 5xx → B, недоступный A → B, пустой остаток → возврат, хаос-тест на обоих поставщиках (≤ 1 ключа на заказ) |
| `recovery.e2e-spec.ts` | этап 4: зависший `delivering`, повтор запаркованных заказов, сверка, журнал сходится |
| `catalog.e2e-spec.ts` | этап 5: витрина с keyset-пагинацией, списание остатка, план запроса на 5 000 SKU идёт по индексу |
| `multi-item.e2e-spec.ts` | **второе задание, задача 1**: три позиции от двух поставщиков; одна позиция не выдаётся → возврат, остальное у покупателя; ничего не выдаётся → полный возврат; воркер умер между позициями → recovery дожимает без второго кода; платёжка отвергла возврат → повтор платит ровно один раз; хаос на 12 заказов × 3 позиции — у каждого заказа оплачено = выдано + возвращено |

Каждый тест заканчивается проверкой инвариантов прямо в базе
(`expectConsistent` в `test/helpers.ts`): число выдач = число выданных позиций
= число уникальных кодов = число ключей, списанных у поставщиков; число
возвратов = число возвращённых позиций = число возвратов на стороне платёжки;
для каждого оплаченного заказа оплачено = выдано + возвращено + ещё открыто, у
финальных открытого нет; журнал сходится в ноль.

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
npm run pay                               # A выдал код и завис → delivery_failed, B не трогаем
curl http://localhost:3000/api/orders/<id>          # attempts: a:timeout ×3, delivery = null

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
`refund.completed`, `refund.failed`, `delivery.completed`, `delivery.parked`,
`recovery.sweep`.

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

## API

Префикс `/api`. Тела — JSON.

| Метод и путь | Назначение |
| --- | --- |
| `GET /health` | приложение и база |
| `GET /products?type=&limit=&cursor=` | витрина: активные товары с остатком, keyset-пагинация по `sku` |
| `POST /orders` `{items: [{sku, quantity?}]}` или `{sku}` | создать заказ (цены фиксируются из каталога, одна позиция на единицу) → `201` |
| `GET /orders/:id` | заказ, позиции (`items[].delivery` / `items[].refund`), деньги (`money`) и история обращений к поставщикам (`attempts`) |
| `POST /orders/:id/deliver` | повторная выдача для `delivery_failed` |
| `POST /webhooks/payment` | вебхук платёжки по контракту; всегда `200` после записи события |
| `POST /stubs/suppliers/{a\|b}/issue` | заглушка поставщика по контракту |
| `GET /stubs/suppliers/{a\|b}` | конфиг сбоев и остаток пула |
| `PUT /stubs/suppliers/{a\|b}/config` `{errorRate, timeoutRate, hangMs, unavailableSkus}` | доля 5xx / зависаний (0..1), SKU «нет в наличии» |
| `POST /stubs/suppliers/{a\|b}/keys` `{codes[]}` | пополнить пул |
| `POST /stubs/payments/refund` `{refund_id, order_id, amount, currency}` | заглушка платёжки: возврат, идемпотентный по `refund_id` |
| `GET /stubs/payments` | конфиг и сколько возвратов получила платёжка |
| `PUT /stubs/payments/config` `{errorRate}` | доля 5xx на возврат |
| `GET /admin/reconciliation` | сверка + балансы журнала |
| `POST /admin/recovery` | прогнать восстановление сейчас |
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
провести.

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
| `DELIVERY_CONCURRENCY` | `4` | параллельных выдач в одном экземпляре |
| `DELIVERY_POLL_INTERVAL_MS` | `2000` | страховочный опрос очереди |
| `PSP_URL` `PSP_TIMEOUT_MS` | `http://localhost:3000/api/stubs/payments` `3000` | заглушка платёжки для возвратов |
| `RECOVERY_INTERVAL_MS` | `30000` | период восстановления |
| `DELIVERY_STALE_AFTER_MS` | `60000` | `delivering` старше — считаем зависшим |
| `RECOVERY_RETRY_AFTER_MS` | `60000` | пауза перед повтором запаркованных |
| `STUB_{A,B}_ERROR_RATE` `STUB_{A,B}_TIMEOUT_RATE` `STUB_HANG_MS` `STUB_PSP_ERROR_RATE` | `0` `0` `10000` `0` | стартовые настройки заглушек |

## Структура

```
backend/src/
├── orders/      Order, OrderItem + статусы, transitionOrder()/transitionItem() (compare-and-set), POST/GET /orders
├── payments/    PaymentEvent (event_id — PK), обработчик вебхука
├── delivery/    Delivery, Refund, DeliveryAttempt, воркер (SKIP LOCKED), политика поставщиков, возвраты, recovery
├── ledger/      двойная запись: cash / customer_liability / revenue (оплата, выдача, возврат)
├── catalog/     Product (+ supplier), ProductStock, витрина
├── admin/       сверка, recovery, генератор каталога, EXPLAIN
├── stubs/       заглушки: поставщики с инъекцией сбоев, платёжка (возвраты)
└── seed/        каталог и пул ключей из приложения к заданию
backend/test/    e2e-тесты (vitest)
backend/scripts/ pay.mjs — эмулятор вебхуков платёжки, stub.mjs — управление заглушками (a, b, psp)
```
