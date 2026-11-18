import {
  type AuthAccessStreamEvent,
  type AuthClientSession,
  type AuthPairingLink,
  type AuthSessionId,
  type TeamActor,
  TeamMemberId,
  type TeamMember,
  type TeamMemberRemoveResult,
  type TeamMemberUpdateInput,
  type TeamPairingMemberInput,
  TEAM_IDENTITY_REQUIRED_MESSAGE,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";

export class TeamsPersistenceError extends Schema.TaggedError<TeamsPersistenceError>()(
  "TeamsPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Team membership storage failed during ${this.operation}.`;
  }
}

export class TeamMemberNotFoundError extends Schema.TaggedError<TeamMemberNotFoundError>()(
  "TeamMemberNotFoundError",
  { memberId: Schema.String },
) {
  override get message(): string {
    return `No team member '${this.memberId}'.`;
  }
}

export class TeamOwnerNotRemovableError extends Schema.TaggedError<TeamOwnerNotRemovableError>()(
  "TeamOwnerNotRemovableError",
  { memberId: Schema.String },
) {
  override get message(): string {
    return "The environment's owner cannot be removed from the team.";
  }
}

export class TeamMemberRevocationError extends Schema.TaggedError<TeamMemberRevocationError>()(
  "TeamMemberRevocationError",
  { memberId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to revoke access for team member '${this.memberId}'.`;
  }
}

export class TeamMemberRemovedError extends Schema.TaggedError<TeamMemberRemovedError>()(
  "TeamMemberRemovedError",
  { memberId: Schema.String },
) {
  override get message(): string {
    return "This pairing link's team member was removed.";
  }
}

/** The fields of an authenticated session that decide who it is. */
export interface TeamSessionIdentity {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly proofKeyThumbprint?: string | undefined;
}

/**
 * `teamsChanged` is a member created, renamed or removed, so open access streams resend a
 * snapshot. `sessionBound` is a new session joining its member, which only needs its own row.
 */
export type TeamsChange =
  | { readonly type: "teamsChanged" }
  | { readonly type: "sessionBound"; readonly sessionId: AuthSessionId };

// Sessions the host itself opens: the desktop app, the startup pairing URL, the reusable dev token.
const OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  "desktop-bootstrap",
  "administrative-bootstrap",
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

const sessionBindingKey = (session: {
  readonly sessionId: string;
  readonly proofKeyThumbprint?: string | undefined;
}) =>
  session.proofKeyThumbprint ? `jkt:${session.proofKeyThumbprint}` : `sid:${session.sessionId}`;

const MemberRow = Schema.Struct({
  id: TeamMemberId,
  name: Schema.String,
  email: Schema.NullOr(Schema.String),
  owner: Schema.Number,
  createdAt: Schema.DateTimeUtcFromString,
  removedAt: Schema.NullOr(Schema.String),
});
const decodeMemberRows = Schema.decodeUnknownEffect(Schema.Array(MemberRow));
const BoundActorRow = Schema.Struct({
  key: Schema.String,
  id: TeamMemberId,
  name: Schema.String,
  viaProofKey: Schema.Number,
});
const decodeBoundActorRows = Schema.decodeUnknownEffect(Schema.Array(BoundActorRow));

type MemberRow = typeof MemberRow.Type;

const toMember = (row: MemberRow): TeamMember => ({
  id: row.id,
  name: row.name,
  ...(row.email ? { email: row.email } : {}),
  owner: row.owner === 1,
  createdAt: row.createdAt,
});

const toActor = (member: { readonly id: TeamMemberId; readonly name: string }): TeamActor => ({
  memberId: member.id,
  name: member.name,
});

export class Teams extends Context.Service<
  Teams,
  {
    /** Active members, owner first. */
    readonly listMembers: () => Effect.Effect<ReadonlyArray<TeamMember>, TeamsPersistenceError>;
    /** An existing active member, or one found or added by name. */
    readonly resolvePairingMember: (
      input: TeamPairingMemberInput,
    ) => Effect.Effect<TeamMember, TeamMemberNotFoundError | TeamsPersistenceError>;
    /** The member id a new pairing link binds to, finding or adding a member given by name. */
    readonly pairingLinkMemberId: (
      teamMember: TeamMemberId | { readonly name: string; readonly email?: string } | undefined,
    ) => Effect.Effect<TeamMemberId | undefined, TeamsPersistenceError>;
    readonly bindPairingLink: (
      pairingLinkId: string,
      memberId: TeamMemberId,
    ) => Effect.Effect<void, TeamsPersistenceError>;
    /**
     * Records who a newly issued session is: its pairing link's member, or else whoever the
     * session it replaced was (a browser re-pair). A link whose member was removed meanwhile
     * revokes the session and fails, so the pairing does not sign in as no one.
     */
    readonly bindIssuedSession: (input: {
      readonly sessionId: AuthSessionId;
      readonly proofKeyThumbprint?: string | undefined;
      readonly pairingLinkId?: string | undefined;
      readonly replacedSessionId?: AuthSessionId | undefined;
    }) => Effect.Effect<void, TeamMemberRemovedError | TeamsPersistenceError>;
    /** Forgets revoked sessions, so a device re-pairing later starts as no one. */
    readonly unbindSessions: (
      sessionIds: ReadonlyArray<AuthSessionId>,
    ) => Effect.Effect<void, TeamsPersistenceError>;
    /** Forgets a revoked device key; a removed member's key stays marked so it can't return. */
    readonly unbindProofKey: (
      proofKeyThumbprint: string,
    ) => Effect.Effect<void, TeamsPersistenceError>;
    /** Forgets every session and device key but the ones given ("sign out other devices"). */
    readonly unbindAllExcept: (keep: {
      readonly sessionId: AuthSessionId;
      readonly proofKeyThumbprint: string | null;
    }) => Effect.Effect<void, TeamsPersistenceError>;
    /** Whether this device key belonged to a member who was removed. */
    readonly isRemovedMemberProofKey: (
      proofKeyThumbprint: string,
    ) => Effect.Effect<boolean, TeamsPersistenceError>;
    /** Who an authenticated session is right now, or undefined when it is nobody on the team. */
    readonly resolveActor: (
      session: TeamSessionIdentity,
    ) => Effect.Effect<TeamActor | undefined, TeamsPersistenceError>;
    readonly withPairingLinkMembers: (
      links: ReadonlyArray<AuthPairingLink>,
    ) => Effect.Effect<ReadonlyArray<AuthPairingLink>, TeamsPersistenceError>;
    readonly withClientSessionMembers: (
      clientSessions: ReadonlyArray<AuthClientSession>,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, TeamsPersistenceError>;
    readonly updateMember: (
      input: TeamMemberUpdateInput,
    ) => Effect.Effect<TeamMember, TeamMemberNotFoundError | TeamsPersistenceError>;
    /**
     * Removes a member and revokes its sessions, devices and unused links. Safe to retry: a
     * member already removed still has whatever was left bound to it revoked.
     */
    readonly removeMember: (
      memberId: TeamMemberId,
    ) => Effect.Effect<
      TeamMemberRemoveResult,
      | TeamMemberNotFoundError
      | TeamOwnerNotRemovableError
      | TeamMemberRevocationError
      | TeamsPersistenceError
    >;
    readonly streamChanges: Stream.Stream<TeamsChange>;
  }
>()("t3/teams/Teams") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const sessions = yield* SessionStore.SessionStore;
  const pairingGrants = yield* PairingGrantStore.PairingGrantStore;
  const changes = yield* PubSub.unbounded<TeamsChange>();
  const publishChange = PubSub.publish(changes, { type: "teamsChanged" } as const).pipe(
    Effect.asVoid,
  );

  const persistence =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new TeamsPersistenceError({ operation, cause })));

  const selectActiveMembers = sql`
    SELECT id, name, email, owner, created_at AS "createdAt", removed_at AS "removedAt"
    FROM team_members WHERE removed_at IS NULL ORDER BY owner DESC, created_at, id
  `.pipe(Effect.flatMap(decodeMemberRows));

  const getMemberRow = (memberId: string) =>
    sql`
      SELECT id, name, email, owner, created_at AS "createdAt", removed_at AS "removedAt"
      FROM team_members WHERE id = ${memberId}
    `.pipe(
      Effect.flatMap(decodeMemberRows),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  // Exactly one owner exists from the first start. The insert decides in one statement, so two
  // processes starting at once can't both add one; the partial unique index backs that up.
  yield* Effect.gen(function* () {
    const id = TeamMemberId.make(yield* random.uuidV4());
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const name = (yield* HostProcess.Username) ?? "Owner";
    yield* sql`
      INSERT INTO team_members (id, name, email, owner, created_at)
      SELECT ${id}, ${name}, NULL, 1, ${createdAt}
      WHERE NOT EXISTS (SELECT 1 FROM team_members WHERE owner = 1)
      ON CONFLICT DO NOTHING
    `;
  }).pipe(persistence("ensureOwner"));

  const listMembers: Teams["Service"]["listMembers"] = Effect.fn("Teams.listMembers")(function* () {
    return (yield* selectActiveMembers).map(toMember);
  }, persistence("listMembers"));

  // Reusing an active member by name keeps `--member alex` and the web's "new member" stable.
  // Insert-if-absent and the read are single statements, so two callers can't add the same name.
  const findOrCreateMember = Effect.fn("Teams.findOrCreateMember")(function* (input: {
    readonly name: string;
    readonly email?: string | undefined;
  }) {
    const id = TeamMemberId.make(yield* random.uuidV4());
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const inserted = yield* sql<{ readonly id: string }>`
        INSERT INTO team_members (id, name, email, owner, created_at)
        SELECT ${id}, ${input.name}, ${input.email ?? null}, 0, ${createdAt}
        WHERE NOT EXISTS (
          SELECT 1 FROM team_members
          WHERE removed_at IS NULL AND lower(trim(name)) = lower(trim(${input.name}))
        )
        RETURNING id
      `;
    const rows = yield* sql`
        SELECT id, name, email, owner, created_at AS "createdAt", removed_at AS "removedAt"
        FROM team_members
        WHERE removed_at IS NULL AND lower(trim(name)) = lower(trim(${input.name}))
        ORDER BY owner DESC, created_at, id
        LIMIT 1
      `.pipe(Effect.flatMap(decodeMemberRows));
    if (inserted.length > 0) yield* publishChange;
    return toMember(rows[0]!);
  }, persistence("findOrCreateMember"));

  const resolvePairingMember: Teams["Service"]["resolvePairingMember"] = Effect.fn(
    "Teams.resolvePairingMember",
  )(function* (input) {
    if (!("memberId" in input)) return yield* findOrCreateMember(input);
    const row = yield* getMemberRow(input.memberId).pipe(persistence("getMember"));
    if (Option.isNone(row) || row.value.removedAt !== null) {
      return yield* new TeamMemberNotFoundError({ memberId: input.memberId });
    }
    return toMember(row.value);
  });

  const pairingLinkMemberId: Teams["Service"]["pairingLinkMemberId"] = (teamMember) =>
    teamMember === undefined || typeof teamMember === "string"
      ? Effect.succeed(teamMember)
      : findOrCreateMember(teamMember).pipe(Effect.map((member) => member.id));

  // A link is bound before anyone holds its credential, so no open stream shows it yet.
  const bindPairingLink: Teams["Service"]["bindPairingLink"] = (pairingLinkId, memberId) =>
    sql`
      INSERT INTO team_pairing_link_members (pairing_link_id, member_id)
      VALUES (${pairingLinkId}, ${memberId})
      ON CONFLICT (pairing_link_id) DO UPDATE SET member_id = excluded.member_id
    `.pipe(Effect.asVoid, persistence("bindPairingLink"), Effect.withSpan("Teams.bindPairingLink"));

  const unbindRemovedProofKey = (key: string) =>
    sql`
      DELETE FROM team_session_members
      WHERE binding_key = ${key}
        AND member_id IN (SELECT id FROM team_members WHERE removed_at IS NOT NULL)
    `.pipe(Effect.asVoid, persistence("unbindRemovedProofKey"));

  const refuseRemoved = (sessionId: AuthSessionId, memberId: string) =>
    sessions
      .revoke(sessionId)
      .pipe(Effect.ignore, Effect.andThen(Effect.fail(new TeamMemberRemovedError({ memberId }))));

  const bindIssuedSession: Teams["Service"]["bindIssuedSession"] = Effect.fn(
    "Teams.bindIssuedSession",
  )(function* (input) {
    const key = sessionBindingKey(input);
    // Link rows outlive their member's removal (see removeMember), so a pairing that spent the
    // link just before the removal can still tell.
    const fromLink =
      input.pairingLinkId === undefined
        ? []
        : yield* sql<{ readonly memberId: string; readonly removed: number }>`
            SELECT l.member_id AS "memberId", m.removed_at IS NOT NULL AS "removed"
            FROM team_pairing_link_members l JOIN team_members m ON m.id = l.member_id
            WHERE l.pairing_link_id = ${input.pairingLinkId}
          `.pipe(persistence("readPairingLinkMember"));
    const link = fromLink[0];
    if (link !== undefined && link.removed === 1) {
      return yield* refuseRemoved(input.sessionId, link.memberId);
    }
    const fromReplaced =
      link !== undefined || input.replacedSessionId === undefined
        ? []
        : yield* sql<{ readonly memberId: string }>`
            SELECT b.member_id AS "memberId"
            FROM team_session_members b JOIN team_members m ON m.id = b.member_id
            WHERE b.binding_key = ${`sid:${input.replacedSessionId}`} AND m.removed_at IS NULL
          `.pipe(persistence("readReplacedSessionMember"));
    const memberId = link?.memberId ?? fromReplaced[0]?.memberId;
    if (memberId === undefined) {
      // The host let a removed member's device back in (approval or an unbound link), as no one.
      if (input.proofKeyThumbprint !== undefined) yield* unbindRemovedProofKey(key);
      return;
    }
    // Checked in the write itself, so a removal landing after the reads above still wins.
    const bound = yield* sql<{ readonly key: string }>`
      INSERT INTO team_session_members (binding_key, member_id)
      SELECT ${key}, ${memberId}
      WHERE EXISTS (SELECT 1 FROM team_members WHERE id = ${memberId} AND removed_at IS NULL)
      ON CONFLICT (binding_key) DO UPDATE SET member_id = excluded.member_id
      RETURNING binding_key AS "key"
    `.pipe(persistence("bindSession"));
    if (bound.length === 0) return yield* refuseRemoved(input.sessionId, memberId);
    if (input.replacedSessionId !== undefined) {
      yield* sql`
        DELETE FROM team_session_members
        WHERE binding_key = ${`sid:${input.replacedSessionId}`} AND binding_key <> ${key}
      `.pipe(persistence("unbindReplacedSession"));
    }
    yield* PubSub.publish(changes, { type: "sessionBound", sessionId: input.sessionId });
  });

  const unbindSessions: Teams["Service"]["unbindSessions"] = (sessionIds) =>
    sessionIds.length === 0
      ? Effect.void
      : sql`
          DELETE FROM team_session_members
          WHERE ${sql.in(
            "binding_key",
            sessionIds.map((sessionId) => `sid:${sessionId}`),
          )}
        `.pipe(
          Effect.asVoid,
          persistence("unbindSessions"),
          Effect.withSpan("Teams.unbindSessions"),
        );

  const unbindProofKey: Teams["Service"]["unbindProofKey"] = (proofKeyThumbprint) =>
    sql`
      DELETE FROM team_session_members
      WHERE binding_key = ${`jkt:${proofKeyThumbprint}`}
        AND member_id IN (SELECT id FROM team_members WHERE removed_at IS NULL)
    `.pipe(Effect.asVoid, persistence("unbindProofKey"), Effect.withSpan("Teams.unbindProofKey"));

  const unbindAllExcept: Teams["Service"]["unbindAllExcept"] = (keep) =>
    sql`
      DELETE FROM team_session_members
      WHERE binding_key <> ${`sid:${keep.sessionId}`}
        AND binding_key <> ${keep.proofKeyThumbprint === null ? "" : `jkt:${keep.proofKeyThumbprint}`}
        AND (
          binding_key LIKE 'sid:%'
          OR member_id IN (SELECT id FROM team_members WHERE removed_at IS NULL)
        )
    `.pipe(Effect.asVoid, persistence("unbindAllExcept"), Effect.withSpan("Teams.unbindAllExcept"));

  const isRemovedMemberProofKey: Teams["Service"]["isRemovedMemberProofKey"] = (
    proofKeyThumbprint,
  ) =>
    sql`
      SELECT 1 FROM team_session_members b JOIN team_members m ON m.id = b.member_id
      WHERE b.binding_key = ${`jkt:${proofKeyThumbprint}`} AND m.removed_at IS NOT NULL
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      persistence("isRemovedMemberProofKey"),
      Effect.withSpan("Teams.isRemovedMemberProofKey"),
    );

  const ownerMember = sql`
    SELECT id, name, email, owner, created_at AS "createdAt", removed_at AS "removedAt"
    FROM team_members WHERE owner = 1
  `.pipe(
    Effect.flatMap(decodeMemberRows),
    Effect.map((rows) => rows[0]),
  );

  const resolveActor: Teams["Service"]["resolveActor"] = Effect.fn("Teams.resolveActor")(function* (
    session,
  ) {
    const keys = [
      ...(session.proofKeyThumbprint ? [`jkt:${session.proofKeyThumbprint}`] : []),
      `sid:${session.sessionId}`,
    ];
    const bound = yield* sql<{ readonly id: TeamMemberId; readonly name: string }>`
        SELECT m.id AS "id", m.name AS "name"
        FROM team_session_members b JOIN team_members m ON m.id = b.member_id
        WHERE ${sql.in("b.binding_key", keys)} AND m.removed_at IS NULL
        ORDER BY b.binding_key LIKE 'jkt:%' DESC
        LIMIT 1
      `;
    if (bound[0]) return toActor(bound[0]);
    if (!OWNER_SUBJECTS.has(session.subject)) return undefined;
    const owner = yield* ownerMember;
    return owner ? toActor(owner) : undefined;
  }, persistence("resolveActor"));

  // One read for the sessions in hand: each session's own binding and its device key's, by
  // way of the key the session table records, so a listing costs one query, not one per row.
  const withClientSessionMembers: Teams["Service"]["withClientSessionMembers"] = Effect.fn(
    "Teams.withClientSessionMembers",
  )(function* (clientSessions) {
    if (clientSessions.length === 0) return clientSessions;
    const rows = yield* sql`
      SELECT s.session_id AS "key", m.id AS "id", m.name AS "name",
        b.binding_key LIKE 'jkt:%' AS "viaProofKey"
      FROM auth_sessions s
      JOIN team_session_members b
        ON b.binding_key = 'sid:' || s.session_id
        OR b.binding_key = 'jkt:' || s.proof_key_thumbprint
      JOIN team_members m ON m.id = b.member_id AND m.removed_at IS NULL
      WHERE ${sql.in(
        "s.session_id",
        clientSessions.map((clientSession) => clientSession.sessionId),
      )}
    `.pipe(Effect.flatMap(decodeBoundActorRows));
    const bySession = new Map<string, typeof BoundActorRow.Type>();
    for (const row of rows) {
      const current = bySession.get(row.key);
      if (current === undefined || (row.viaProofKey === 1 && current.viaProofKey !== 1)) {
        bySession.set(row.key, row);
      }
    }
    const owner = clientSessions.some((clientSession) => OWNER_SUBJECTS.has(clientSession.subject))
      ? yield* ownerMember
      : undefined;
    return clientSessions.map((clientSession) => {
      const bound = bySession.get(clientSession.sessionId);
      const teamMember = bound
        ? toActor(bound)
        : owner && OWNER_SUBJECTS.has(clientSession.subject)
          ? toActor(owner)
          : undefined;
      return teamMember ? { ...clientSession, teamMember } : clientSession;
    });
  }, persistence("withClientSessionMembers"));

  const withPairingLinkMembers: Teams["Service"]["withPairingLinkMembers"] = Effect.fn(
    "Teams.withPairingLinkMembers",
  )(function* (links) {
    if (links.length === 0) return links;
    const rows = yield* sql`
      SELECT l.pairing_link_id AS "key", m.id AS "id", m.name AS "name", 0 AS "viaProofKey"
      FROM team_pairing_link_members l
      JOIN team_members m ON m.id = l.member_id AND m.removed_at IS NULL
      WHERE ${sql.in(
        "l.pairing_link_id",
        links.map((link) => link.id),
      )}
    `.pipe(Effect.flatMap(decodeBoundActorRows));
    const byLink = new Map(rows.map((row) => [row.key, toActor(row)] as const));
    return links.map((link) => {
      const teamMember = byLink.get(link.id);
      return teamMember ? { ...link, teamMember } : link;
    });
  }, persistence("withPairingLinkMembers"));

  const updateMember: Teams["Service"]["updateMember"] = Effect.fn("Teams.updateMember")(
    function* (input) {
      const row = yield* getMemberRow(input.memberId).pipe(persistence("getMember"));
      if (Option.isNone(row) || row.value.removedAt !== null) {
        return yield* new TeamMemberNotFoundError({ memberId: input.memberId });
      }
      const email = input.email === undefined ? row.value.email : input.email;
      yield* sql`
        UPDATE team_members SET name = ${input.name}, email = ${email} WHERE id = ${input.memberId}
      `.pipe(persistence("updateMember"));
      yield* publishChange;
      return toMember({ ...row.value, name: input.name, email });
    },
  );

  const removeMember: Teams["Service"]["removeMember"] = Effect.fn("Teams.removeMember")(
    function* (memberId) {
      const row = yield* getMemberRow(memberId).pipe(persistence("getMember"));
      if (Option.isNone(row)) return yield* new TeamMemberNotFoundError({ memberId });
      if (row.value.owner === 1) return yield* new TeamOwnerNotRemovableError({ memberId });
      const alreadyRemoved = row.value.removedAt !== null;

      // Marked before the bindings are read: a pairing binding after this is refused, and one
      // that bound before it is in the read below.
      if (!alreadyRemoved) {
        const removedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`UPDATE team_members SET removed_at = ${removedAt} WHERE id = ${memberId}`.pipe(
          persistence("markMemberRemoved"),
        );
      }
      const sessionKeys = yield* sql<{ readonly key: string }>`
        SELECT binding_key AS "key" FROM team_session_members WHERE member_id = ${memberId}
      `.pipe(persistence("readMemberSessions"));
      const links = yield* sql<{ readonly id: string }>`
        SELECT pairing_link_id AS "id" FROM team_pairing_link_members WHERE member_id = ${memberId}
      `.pipe(persistence("readMemberLinks"));

      const revokedSessions = yield* Effect.gen(function* () {
        let revoked = 0;
        for (const { key } of sessionKeys) {
          if (key.startsWith("jkt:")) {
            const proofKeyThumbprint = key.slice("jkt:".length);
            // A trusted T3 Connect key would otherwise mint itself a new session within the hour.
            yield* pairingGrants.revokeConnectDevice(proofKeyThumbprint);
            revoked += yield* sessions.revokeByProofKey(proofKeyThumbprint);
          } else if (yield* sessions.revoke(key.slice("sid:".length) as AuthSessionId)) {
            revoked += 1;
          }
        }
        yield* Effect.forEach(links, (link) => pairingGrants.revoke(link.id), { discard: true });
        return revoked;
      }).pipe(Effect.mapError((cause) => new TeamMemberRevocationError({ memberId, cause })));

      // Session rows go once revoked. Device-key and link rows stay: they mark the member's
      // devices and links as removed (see bindIssuedSession and isRemovedMemberProofKey), and a
      // retry re-revokes them for nothing. The boot prune drops links that can no longer pair.
      yield* sql`
        DELETE FROM team_session_members WHERE member_id = ${memberId} AND binding_key LIKE 'sid:%'
      `.pipe(persistence("unbindMemberSessions"));
      if (!alreadyRemoved) yield* publishChange;
      return { removed: !alreadyRemoved, revokedSessions };
    },
  );

  return Teams.of({
    listMembers,
    resolvePairingMember,
    pairingLinkMemberId,
    bindPairingLink,
    bindIssuedSession,
    unbindSessions,
    unbindProofKey,
    unbindAllExcept,
    isRemovedMemberProofKey,
    resolveActor,
    withPairingLinkMembers,
    withClientSessionMembers,
    updateMember,
    removeMember,
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
  });
});

export const layer = Layer.effect(Teams, make);

export class TeamIdentityRequiredError extends Schema.TaggedError<TeamIdentityRequiredError>()(
  "TeamIdentityRequiredError",
  {},
) {
  override get message(): string {
    return TEAM_IDENTITY_REQUIRED_MESSAGE;
  }
}

/** Who a session is when its request runs; refuses a session that is nobody on the team. */
export const requireSessionActor = Effect.fn("Teams.requireSessionActor")(function* (
  session: TeamSessionIdentity,
) {
  const teams = yield* Teams;
  const actor = yield* teams.resolveActor(session);
  if (actor === undefined) return yield* new TeamIdentityRequiredError();
  return actor;
});

/** Commands that start work, so they need a member to act as. */
export const isTeamWorkCommand = (command: { readonly type: string }): boolean =>
  command.type === "thread.create" ||
  command.type === "message.dispatch" ||
  command.type === "thread.fork" ||
  command.type === "thread.merge_back" ||
  command.type === "delegated_task.request";

/**
 * Only the host decides who a device is: minting a member-bound link or renaming or removing a
 * member needs the owner. Every paired client holds `access:write`, so the scope alone can't.
 */
export const isOwnerSession = Effect.fn("Teams.isOwnerSession")(function* (
  session: TeamSessionIdentity,
) {
  const teams = yield* Teams;
  const actor = yield* teams.resolveActor(session);
  if (actor === undefined) return false;
  return (yield* teams.listMembers()).some(
    (member) => member.owner && member.id === actor.memberId,
  );
});

/**
 * Fills in team members on one access stream's events. It remembers the sessions the stream has
 * shown, so a session bound just after its `clientUpserted` went out is resent with its member
 * instead of making every open stream reload a whole snapshot.
 */
export const makeAccessStreamDecorator = (
  teams: Pick<Teams["Service"], "withClientSessionMembers" | "withPairingLinkMembers">,
) => {
  const shown = new Map<AuthSessionId, AuthClientSession>();
  const remember = (clientSessions: ReadonlyArray<AuthClientSession>) => {
    for (const clientSession of clientSessions) shown.set(clientSession.sessionId, clientSession);
  };
  const decorate = Effect.fnUntraced(function* (
    event: AuthAccessStreamEvent,
  ): Effect.fn.Return<AuthAccessStreamEvent, TeamsPersistenceError> {
    switch (event.type) {
      case "pairingLinkRemoved":
        return event;
      case "clientRemoved":
        shown.delete(event.payload.sessionId);
        return event;
      case "pairingLinkUpserted": {
        const [payload] = yield* teams.withPairingLinkMembers([event.payload]);
        return { ...event, payload: payload ?? event.payload };
      }
      case "clientUpserted": {
        shown.set(event.payload.sessionId, event.payload);
        const [payload] = yield* teams.withClientSessionMembers([event.payload]);
        return { ...event, payload: payload ?? event.payload };
      }
      // Snapshots are built from listings that already carry members.
      case "snapshot":
        remember(event.payload.clientSessions);
        return event;
    }
  });
  return {
    remember,
    /** Whether a `sessionBound` change concerns a session this stream has shown. */
    hasShown: (sessionId: AuthSessionId) => shown.has(sessionId),
    decorate,
    /** The shown session's row again, now with its member. Only for a session `hasShown`. */
    rebound: (
      sessionId: AuthSessionId,
      revision: number,
    ): Effect.Effect<AuthAccessStreamEvent | undefined, TeamsPersistenceError> => {
      const payload = shown.get(sessionId);
      return payload === undefined
        ? Effect.undefined
        : decorate({ version: 1, revision, type: "clientUpserted", payload });
    },
  };
};
