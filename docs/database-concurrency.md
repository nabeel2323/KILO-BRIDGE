# Database Persistence and Concurrency

## Why this exists

Kilo Bridge currently uses `sql.js`, which keeps a complete SQLite database in process memory and exports the complete database file after mutations. A normal SQL uniqueness constraint does not by itself protect two independent Bridge processes that opened different in-memory snapshots: the later process could otherwise export an older snapshot over a newer file.

## Write protocol

Every persisted mutation follows this protocol:

1. The store remembers the SHA-256 digest of the database file it loaded or most recently wrote.
2. A short-lived cross-process lock (`<database>.persist.lock`) serializes file replacement.
3. While holding that lock, the store hashes the current database file again.
4. If the on-disk digest differs from the store's remembered digest, the process marks its store instance stale and refuses the write.
5. If the digests match, the store exports to a unique temporary file in the same directory, flushes it, and atomically renames it over the database file.
6. The store records the digest of the newly persisted file and releases the lock.

This is optimistic concurrency control with fail-closed conflict detection. It is intentionally not a merge protocol: when another process wins a write race, the stale process must close and reopen the database before it can read or mutate state again.

## Close and crash behavior

Mutations are persisted at the point they are applied. Closing a store does not export its in-memory snapshot, because a close-time export could overwrite a newer write from another process. A process crash after a successful mutation therefore does not depend on a later close operation to save that mutation.

The lock uses atomic file creation and token ownership. A malformed or uncertain lock is not deleted automatically. A stale lock may be reconciled only when its recorded process is confirmed not to be alive and the token remains unchanged.

## Operational implications

- Keep database operations short; do not hold a persistence lock while making GitHub or model-provider network calls.
- A concurrent writer may receive `DATABASE_WRITE_CONFLICT`; it must close and reopen the store, then re-read durable state before retrying.
- Intake must preserve its durable claim/reconciliation state when this happens and must never retry a dispatch whose outcome is uncertain.
- Tests must prove that concurrent snapshots cannot cause last-writer-wins data loss.
- This mechanism protects persisted file integrity, but it does not replace the need for the intake claim's unique repository/Issue/generation key or the intake service's exclusive poll lock.

## Current limitation

The concurrency layer is designed to prevent stale snapshot overwrites. Production intake must remain disabled until the full service is integrated with the app lifecycle and the end-to-end restart/reconciliation tests pass.
