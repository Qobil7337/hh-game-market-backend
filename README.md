# hh-game-market-backend

NestJS 12 (ESM) on Fastify, with TypeORM against PostgreSQL.

```
backend/
├── .env / .env.example
└── src/
    ├── app.module.ts        ConfigModule + TypeOrmModule
    ├── main.ts              Fastify bootstrap
    └── health/              GET /api/health, pings the database
```

## Requirements

- Node 22+ (developed on Node 24 via nvm)
- A reachable PostgreSQL instance matching `backend/.env`

## Run

```bash
cd backend
npm install          # first time only
npm run start:dev
```

```
GET http://localhost:3000/api          -> Hello World!
GET http://localhost:3000/api/health   -> {"status":"ok","database":"up"}
```

## Configuration

`backend/.env` (see `.env.example`):

| Variable | Default |
| --- | --- |
| `PORT` | `3000` |
| `DB_HOST` / `DB_PORT` | `localhost` / `5432` |
| `DB_USERNAME` / `DB_PASSWORD` / `DB_DATABASE` | `hh` / `hh_dev_password` / `hh_game_market` |

There are no migrations: `synchronize` is on unless `NODE_ENV=production`, so
TypeORM creates tables from the entities on boot.

## npm scripts (run from `backend/`)

| Script | What it does |
| --- | --- |
| `npm run start:dev` | Nest in watch mode |
| `npm run build` / `start:prod` | compile to `dist/`, run the compiled app |
| `npm run format` | prettier |

## Notes

- The project is ESM (`"type": "module"`), so **relative imports need the `.js`
  extension**, even from `.ts` files.
- Register entities with `TypeOrmModule.forFeature([...])` in their feature
  module; `autoLoadEntities` picks them up from there.
