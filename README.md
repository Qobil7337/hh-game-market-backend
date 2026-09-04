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
живут в этом же процессе, но воркер ходит к ним по HTTP — таймауты настоящие.

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

29 e2e-тестов в `backend/test/`:

| Файл | Что проверяет |
| --- | --- |
| `orders.e2e-spec.ts` | этап 1: жизненный цикл, `payment_failed`, дубль `event_id`, событие для неизвестного заказа, несовпадение суммы |
| `races.e2e-spec.ts` | этап 2: **два экземпляра приложения на одной базе**; 50 повторов одного `event_id`, 50 разных `event_id` на один заказ, гонка paid/failed, события не по порядку, 20 заказов × 5 вебхуков разом |
| `suppliers.e2e-spec.ts` | этап 3: ловушка таймаута, неразрешённый таймаут не уходит на fallback, 5xx → B, недоступный A → B, пустой остаток → пополнение → выдача, хаос-тест на обоих поставщиках (≤ 1 ключа на заказ) |
| `recovery.e2e-spec.ts` | этап 4: зависший `delivering`, повтор запаркованных заказов, сверка, журнал сходится |
| `catalog.e2e-spec.ts` | этап 5: витрина с keyset-пагинацией, списание остатка, план запроса на 5 000 SKU идёт по индексу |

Каждый тест заканчивается проверкой инвариантов прямо в базе
(`expectConsistent` в `test/helpers.ts`): число выдач = число доставленных
заказов = число уникальных кодов = число ключей, списанных у поставщиков;
журнал сходится в ноль.

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
NULL`), оплатите заказ — он встанет в `out_of_stock`; пополните пул любого
поставщика и вызовите `/deliver` (или дождитесь recovery).

### Сверка и восстановление (этап 4)

```bash
curl http://localhost:3000/api/admin/reconciliation   # "оплачен, но не выдан", "выдан, но не оплачен", журнал
curl -X POST http://localhost:3000/api/admin/recovery # прогнать восстановление сейчас
```

Фоновое восстановление и так идёт раз в `RECOVERY_INTERVAL_MS`: заказы,
застрявшие в `delivering` дольше `DELIVERY_STALE_AFTER_MS`, и запаркованные
(`out_of_stock`, `delivery_failed`) старше `RECOVERY_RETRY_AFTER_MS`
возвращаются в очередь. Повторная выдача идемпотентна: те же `request_id`, и
поставщик, который ранее ответил таймаутом, опрашивается первым.

Логи — по строке JSON на событие (`LOG_FORMAT=json`): `payment.webhook`,
`delivery.attempt`, `delivery.completed`, `delivery.parked`, `recovery.sweep`.

### Каталог под нагрузкой (этап 5)

```bash
curl -X POST http://localhost:3000/api/admin/catalog/generate \
     -H 'content-type: application/json' -d '{"count":100000}'
curl 'http://localhost:3000/api/products?type=key&limit=50'
curl 'http://localhost:3000/api/products?type=key&limit=50&cursor=GEN-KEY-0001234'
curl 'http://localhost:3000/api/admin/explain?type=key&limit=50'   # EXPLAIN (ANALYZE, BUFFERS)
```

## API

Префикс `/api`. Тела — JSON.

| Метод и путь | Назначение |
| --- | --- |
| `GET /health` | приложение и база |
| `GET /products?type=&limit=&cursor=` | витрина: активные товары с остатком, keyset-пагинация по `sku` |
| `POST /orders` `{sku}` | создать заказ (цена фиксируется из каталога) → `201` |
| `GET /orders/:id` | заказ, выдача (`delivery`) и история обращений к поставщикам (`attempts`) |
| `POST /orders/:id/deliver` | повторная выдача для `out_of_stock` / `delivery_failed` |
| `POST /webhooks/payment` | вебхук платёжки по контракту; всегда `200` после записи события |
| `POST /stubs/suppliers/{a\|b}/issue` | заглушка поставщика по контракту |
| `GET /stubs/suppliers/{a\|b}` | конфиг сбоев и остаток пула |
| `PUT /stubs/suppliers/{a\|b}/config` `{errorRate, timeoutRate, hangMs}` | доля 5xx / зависаний (0..1) |
| `POST /stubs/suppliers/{a\|b}/keys` `{codes[]}` | пополнить пул |
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
created ──paid──▶ paid ──▶ delivering ──▶ delivered
   │                            │
   └──failed──▶ payment_failed  ├──▶ out_of_stock    ──┐ восстановимые:
                                └──▶ delivery_failed ──┘ /deliver или recovery → paid → …
```

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
| `RECOVERY_INTERVAL_MS` | `30000` | период восстановления |
| `DELIVERY_STALE_AFTER_MS` | `60000` | `delivering` старше — считаем зависшим |
| `RECOVERY_RETRY_AFTER_MS` | `60000` | пауза перед повтором запаркованных |
| `STUB_{A,B}_ERROR_RATE` `STUB_{A,B}_TIMEOUT_RATE` `STUB_HANG_MS` | `0` `0` `10000` | стартовые настройки заглушек |

## Структура

```
backend/src/
├── orders/      Order + статусы, transitionOrder() (compare-and-set), POST/GET /orders
├── payments/    PaymentEvent (event_id — PK), обработчик вебхука
├── delivery/    Delivery, DeliveryAttempt, воркер (SKIP LOCKED), политика поставщиков, recovery
├── ledger/      двойная запись: cash / customer_liability / revenue
├── catalog/     Product, ProductStock, витрина
├── admin/       сверка, recovery, генератор каталога, EXPLAIN
├── stubs/       поставщики-заглушки с инъекцией сбоев
└── seed/        каталог и пул ключей из приложения к заданию
backend/test/    e2e-тесты (vitest)
backend/scripts/ pay.mjs — эмулятор платёжки, stub.mjs — управление заглушками
```
