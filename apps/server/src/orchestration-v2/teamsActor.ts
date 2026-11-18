import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  TeamActor,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

// teams: fork-owned on-behalf-of resolution. Upstream files call these through `// teams:` hooks.

/** Spreads an optional actor without ever writing `actor: undefined`. */
export const withTeamActor = (actor: TeamActor | undefined): { readonly actor?: TeamActor } =>
  actor === undefined ? {} : { actor };

/**
 * Whether a message sent without an actor works for a thread's driver. An agent here names its
 * sender thread, and the server's own continuations and recoveries act for the thread they
 * resume. An external MCP client or a linked environment's agent has no thread here and asked
 * for nobody, so borrowing the target's driver would say someone sent what they never asked for.
 */
export const inheritsThreadDriver = (message: {
  readonly creationSource: OrchestrationV2CreationSource;
  readonly senderThreadId?: ThreadId | undefined;
  readonly linkedSender?: unknown;
}): boolean =>
  message.senderThreadId !== undefined ||
  (message.linkedSender === undefined && message.creationSource !== "mcp");

/** The actor the newest user-role message names, among the messages given. */
export function latestUserMessageActor(
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "role" | "actor" | "createdAt">>,
): TeamActor | undefined {
  let latest: Pick<OrchestrationV2ConversationMessage, "actor" | "createdAt"> | undefined;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (
      latest === undefined ||
      message.createdAt.epochMilliseconds >= latest.createdAt.epochMilliseconds
    )
      latest = message;
  }
  return latest?.actor;
}

const decodeActorJson = Schema.decodeUnknownOption(Schema.fromJsonString(TeamActor));

/**
 * The person a thread currently works for: whoever its latest user-role message names, else
 * whoever started the thread. Only the latest is read, so a long history from before teams costs
 * nothing; every message dispatched since names someone. A missing thread or an unreadable actor
 * has no driver.
 */
export const readThreadDriver = Effect.fn("teams.readThreadDriver")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{ readonly actor: string | null }>`
    SELECT actor FROM (
      SELECT json_extract(payload_json, '$.actor') AS actor, 0 AS rank
      FROM (
        SELECT payload_json FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId} AND role = 'user'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      )
      WHERE json_type(payload_json, '$.actor') = 'object'
      UNION ALL
      SELECT json_extract(payload_json, '$.actor') AS actor, 1 AS rank
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId} AND json_type(payload_json, '$.actor') = 'object'
    )
    ORDER BY rank
    LIMIT 1
  `;
  const actor = rows[0]?.actor;
  return actor == null ? undefined : Option.getOrUndefined(decodeActorJson(actor));
});

/**
 * A child thread a provider offers copies its parent's fields, actor included. It works for the
 * parent's driver instead; when that cannot be read it keeps the copied actor.
 */
export const withParentDriver = Effect.fn("teams.withParentDriver")(function* <E>(
  projections: {
    readonly getThreadDriver: (threadId: ThreadId) => Effect.Effect<TeamActor | undefined, E>;
  },
  thread: OrchestrationV2AppThread,
) {
  const parentThreadId = thread.lineage.parentThreadId;
  if (parentThreadId === null) return thread;
  const driver = yield* projections
    .getThreadDriver(parentThreadId)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (driver === undefined) return thread;
  return { ...thread, actor: driver };
});
