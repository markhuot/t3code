import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// teams: the fork keeps its own ledger. The core migrator runs only ids above the highest id in
// `effect_sql_migrations`, so a fork id recorded there would make upstream skip its next one.
const TEAMS_MIGRATIONS_TABLE = "teams_sql_migrations";

const TeamTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      owner INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      removed_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS team_members_single_owner
    ON team_members (owner) WHERE owner = 1
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_pairing_link_members (
      pairing_link_id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES team_members (id)
    ) WITHOUT ROWID
  `;
  // `binding_key` is `jkt:<thumbprint>` for DPoP sessions, which renew under new ids, else `sid:<id>`.
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_session_members (
      binding_key TEXT PRIMARY KEY,
      member_id TEXT NOT NULL REFERENCES team_members (id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS team_session_members_member ON team_session_members (member_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS team_pairing_link_members_member
    ON team_pairing_link_members (member_id)
  `;
});

// Who each scheduled task works for. A side table keeps upstream's `scheduled_tasks` intact.
// Applied databases still hold the trigger below; migration 3 drops it.
const ScheduledTaskActors = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS team_scheduled_task_actors (
      task_id TEXT PRIMARY KEY,
      actor_json TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS team_scheduled_task_actors_cleanup
    AFTER DELETE ON scheduled_tasks
    BEGIN
      DELETE FROM team_scheduled_task_actors WHERE task_id = OLD.task_id;
    END
  `;
});

// A trigger on upstream's table is dropped by its table rebuilds and blocks its column renames
// and drops, so orphaned actors are pruned on boot and on delete instead.
const DropScheduledTaskActorsTrigger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS team_scheduled_task_actors_cleanup`;
});

const loader = Migrator.fromRecord({
  "1_TeamTables": TeamTables,
  "2_ScheduledTaskActors": ScheduledTaskActors,
  "3_DropScheduledTaskActorsTrigger": DropScheduledTaskActorsTrigger,
});

const run = Migrator.make({});

/**
 * Rows the fork keeps beside upstream's tables lose their partner without a foreign key: a
 * deleted task, a revoked or expired session, a link that can no longer pair. Idempotent and
 * outside the ledger, so it runs every boot. It reads upstream tables, so a rename upstream
 * makes it log and skip rather than stop the server.
 */
const pruneOrphans = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    DELETE FROM team_scheduled_task_actors
    WHERE task_id NOT IN (SELECT task_id FROM scheduled_tasks)
  `;
  yield* sql`
    DELETE FROM team_session_members
    WHERE binding_key LIKE 'sid:%'
      AND substr(binding_key, 5) NOT IN (
        SELECT session_id FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ${now}
      )
  `;
  yield* sql`
    DELETE FROM team_pairing_link_members
    WHERE pairing_link_id NOT IN (
      SELECT id FROM auth_pairing_links
      WHERE revoked_at IS NULL AND consumed_at IS NULL AND expires_at > ${now}
    )
  `;
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("Could not prune orphaned team rows", cause)),
);

export const runTeamsMigrations = Effect.fn("runTeamsMigrations")(function* () {
  const ran = yield* run({ loader, table: TEAMS_MIGRATIONS_TABLE });
  yield* pruneOrphans;
  return ran;
});
