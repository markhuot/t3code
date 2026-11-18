import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import { runTeamsMigrations } from "./TeamsMigrations.ts";

const latestCoreId = Math.max(...migrationManifest.map(([id]) => id));

it.effect("keeps its own ledger, so a core migration added later still runs", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // A database from before upstream's newest migration, with the fork already applied.
    yield* runMigrations({ toMigrationInclusive: latestCoreId - 1 });
    yield* runTeamsMigrations();

    const ran = yield* runMigrations();

    assert.deepStrictEqual(
      ran.map(([id]) => id),
      [latestCoreId],
    );
    const core = yield* sql<{ readonly maxId: number }>`
      SELECT MAX(migration_id) AS "maxId" FROM effect_sql_migrations
    `;
    assert.strictEqual(core[0]?.maxId, latestCoreId);
    const fork = yield* sql<{ readonly name: string }>`SELECT name FROM teams_sql_migrations`;
    assert.deepStrictEqual(
      fork.map((row) => row.name),
      ["TeamTables", "ScheduledTaskActors", "DropScheduledTaskActorsTrigger"],
    );
    assert.deepStrictEqual(yield* runTeamsMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("prunes rows whose task, session or link is gone on every boot", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* runTeamsMigrations();
    yield* sql`
      INSERT INTO team_members (id, name, owner, created_at)
      VALUES ('member-a', 'A', 0, '2026-01-01T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO team_scheduled_task_actors (task_id, actor_json)
      VALUES ('scheduled-task:deleted', '{"memberId":"member-a","name":"A"}')
    `;
    yield* sql`
      INSERT INTO team_session_members (binding_key, member_id)
      VALUES ('sid:revoked-session', 'member-a'), ('jkt:device-key', 'member-a')
    `;
    yield* sql`
      INSERT INTO team_pairing_link_members (pairing_link_id, member_id)
      VALUES ('spent-link', 'member-a')
    `;

    // Nothing to migrate, but the prune still runs.
    assert.deepStrictEqual(yield* runTeamsMigrations(), []);

    assert.deepStrictEqual(yield* sql`SELECT task_id FROM team_scheduled_task_actors`, []);
    // A device key outlives its expired sessions: T3 Connect renews under new ones.
    assert.deepStrictEqual(
      (yield* sql<{ readonly key: string }>`
        SELECT binding_key AS "key" FROM team_session_members
      `).map((row) => row.key),
      ["jkt:device-key"],
    );
    assert.deepStrictEqual(yield* sql`SELECT pairing_link_id FROM team_pairing_link_members`, []);
    // The trigger upstream table rebuilds would have dropped is gone.
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'team_%'`,
      [],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
