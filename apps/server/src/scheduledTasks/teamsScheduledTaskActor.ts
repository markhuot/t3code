import {
  type ScheduledTask,
  type ScheduledTaskId,
  scheduledTaskThreadMode,
  TeamActor,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

// teams: whom each scheduled task works for, in `team_scheduled_task_actors` (see TeamsMigrations).

const decodeActorJson = Schema.decodeUnknownOption(Schema.fromJsonString(TeamActor));
const encodeActorJson = Schema.encodeSync(Schema.fromJsonString(TeamActor));

export const REMOVED_ACTOR_MESSAGE =
  "The team member this task runs on behalf of was removed. Edit its prompt to run it on your behalf.";

type ActorWrite =
  | { readonly type: "keep" }
  | { readonly type: "clear" }
  | { readonly type: "set"; readonly actor: TeamActor };

const keep: ActorWrite = { type: "keep" };
const clear: ActorWrite = { type: "clear" };

type ActorTarget = Pick<ScheduledTask, "prompt" | "projectId" | "threadId" | "threadMode">;

/**
 * A task works for whoever last saved what it does: its prompt or where it sends it. Other
 * edits (title, schedule, model) keep it. A save also claims a task that has no actor yet or
 * whose member was removed.
 */
export const scheduledTaskActorWrite = Effect.fn("teams.scheduledTaskActorWrite")(function* (
  sql: SqlClient.SqlClient,
  existing: (ActorTarget & { readonly actor?: TeamActor | undefined }) | null,
  next: ActorTarget,
  actor: TeamActor | undefined,
) {
  // A new task, or one recreated under a deleted id, never keeps a stale row.
  if (existing === null) return actor === undefined ? clear : ({ type: "set", actor } as const);
  if (actor === undefined) return keep;
  const retargeted =
    existing.prompt !== next.prompt ||
    existing.projectId !== next.projectId ||
    existing.threadId !== next.threadId ||
    scheduledTaskThreadMode(existing) !== scheduledTaskThreadMode(next);
  if (
    retargeted ||
    existing.actor === undefined ||
    (yield* isScheduledTaskActorRemoved(sql, existing.actor))
  ) {
    return { type: "set", actor } as const;
  }
  return keep;
});

export const applyScheduledTaskActorWrite = (
  sql: SqlClient.SqlClient,
  taskId: ScheduledTaskId,
  write: ActorWrite,
) =>
  write.type === "keep"
    ? Effect.void
    : write.type === "clear"
      ? clearScheduledTaskActor(sql, taskId)
      : sql`
          INSERT INTO team_scheduled_task_actors (task_id, actor_json)
          VALUES (${taskId}, ${encodeActorJson(write.actor)})
          ON CONFLICT (task_id) DO UPDATE SET actor_json = excluded.actor_json
        `.pipe(Effect.asVoid);

export const clearScheduledTaskActor = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId) =>
  sql`DELETE FROM team_scheduled_task_actors WHERE task_id = ${taskId}`.pipe(Effect.asVoid);

/** Whether the member a task works for has been removed from the team. */
export const isScheduledTaskActorRemoved = (
  sql: SqlClient.SqlClient,
  actor: TeamActor | undefined,
) =>
  actor === undefined
    ? Effect.succeed(false)
    : sql`
        SELECT 1 FROM team_members WHERE id = ${actor.memberId} AND removed_at IS NOT NULL
      `.pipe(Effect.map((rows) => rows.length > 0));

/** Turns off a task whose member was removed, the way pausing it would. */
export const pauseScheduledTaskOfRemovedActor = (
  sql: SqlClient.SqlClient,
  taskId: ScheduledTaskId,
  nowIso: string,
) =>
  sql`
    UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL, updated_at = ${nowIso}
    WHERE task_id = ${taskId}
  `.pipe(Effect.asVoid);

export const readScheduledTaskActors = Effect.fn("teams.readScheduledTaskActors")(function* (
  sql: SqlClient.SqlClient,
  taskIds?: ReadonlyArray<ScheduledTaskId>,
) {
  if (taskIds !== undefined && taskIds.length === 0) return new Map<string, TeamActor>();
  const rows = yield* taskIds === undefined
    ? sql<{ readonly task_id: string; readonly actor_json: string }>`
          SELECT task_id, actor_json FROM team_scheduled_task_actors
        `
    : sql<{ readonly task_id: string; readonly actor_json: string }>`
          SELECT task_id, actor_json FROM team_scheduled_task_actors
          WHERE task_id IN ${sql.in(taskIds)}
        `;
  const actors = new Map<string, TeamActor>();
  for (const row of rows) {
    const actor = Option.getOrUndefined(decodeActorJson(row.actor_json));
    if (actor !== undefined) actors.set(row.task_id, actor);
  }
  return actors;
});

export const withScheduledTaskActor = <Task extends { readonly id: ScheduledTaskId }>(
  task: Task,
  actors: ReadonlyMap<string, TeamActor>,
): Task => {
  const actor = actors.get(task.id);
  return actor === undefined ? task : { ...task, actor };
};
