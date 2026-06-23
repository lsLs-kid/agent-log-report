# Task 7 Report: DB Transport

## Summary

Implemented `DbTransport` supporting `postgres://` and `sqlite://` database backends, with a SQLite smoke test and verified TypeScript compilation.

## Files Created

1. `log-sync/src/transports/db.ts` — `DbTransport` class implementing the `Transport` interface.
2. `log-sync/scripts/test-db.ts` — SQLite smoke test script.

## Test Results

- **SQLite smoke test**: `npx tsx scripts/test-db.ts` → `sqlite transport ok` ✅
- **TypeScript type check**: `npx tsc --noEmit` → passed with no errors ✅
- **MySQL smoke test**: Not performed locally (requires MySQL server) — noted below.

## Fixes Applied (2026-06-23)

1. **Added MySQL support** — installed `mysql2` dependency, added `mysql://` scheme handling in `send()`, implemented `sendMysql()` with the same schema pattern (MySQL types: `BIGINT UNSIGNED AUTO_INCREMENT`, `VARCHAR(255)`, `TEXT`, `DATETIME(3)`, `JSON`), indexes, and transactional inserts.
2. **Added tableName SQL injection validation** — constructor now validates `opts.tableName` (or default `'log_sync_records'`) against `^[a-zA-Z_][a-zA-Z0-9_]*$`; throws `LogSyncError('Invalid table name', 'DB_INVALID_TABLE')` on mismatch.
3. **Improved Postgres rollback error handling** — wrapped `client.query('ROLLBACK')` in try/catch inside `sendPostgres`; rollback failures are suppressed so the original transaction error is always re-thrown.

## Notes

- `mysql://` support has been added with `mysql2/promise`. MySQL smoke testing requires a running MySQL server and was not performed locally.
- `better-sqlite3` and `pg` were already installed; `mysql2` was added as a new dependency.
- Table name validation guards against SQL injection via regex `^[a-zA-Z_][a-zA-Z0-9_]*$`.
- Postgres rollback errors are now caught and suppressed so the original transaction error is always thrown.
