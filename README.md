# alysia

ElysiaJS (Bun) + PostgreSQL API for the SCD Panda Oil Transport system,
replacing the Firebase Realtime Database backend used by the frontend.

## Setup

```
bun install
cp .env.example .env   # fill in real values
bun run migrate-passwords   # one-time: bcrypt-hash plaintext passwords already in the DB
bun run dev
```

Bun loads `.env` automatically — no `dotenv` package needed.

## Notes

- `.env` currently uses the `postgres` superuser for simplicity. Before any
  shared/production use, create a scoped role (e.g. `scd_panda_app`) with
  privileges limited to the `scd_panda` schema and use that instead.
- `src/schema-manifest.json` maps Postgres columns back to the original
  Firebase field names (e.g. `bank_id` -> `BankID`). It's generated from the
  same JSON export used to build the SQL dump — regenerate it if the source
  data's field set changes.
- `GET /api/basic-data` is a convenience endpoint mirroring the frontend's
  `BasicDataProvider` shape. Generic CRUD is available at `/api/:table` and
  `/api/:table/:rowKey` for all 31 imported tables.
- Auth (`POST /api/auth/login`) only checks `employee_officers` and
  `employee_drivers` — `employee_creditors` never had `User`/`Password`
  columns in the source data, matching the original app's behavior.
