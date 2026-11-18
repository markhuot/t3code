import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// teams: fork-owned contracts. Upstream files only reference these through `// teams:` hooks.

export const TeamMemberId = TrimmedNonEmptyString.pipe(Schema.brand("TeamMemberId"));
export type TeamMemberId = typeof TeamMemberId.Type;

/**
 * The person a prompt or thread belongs to. `name` is a snapshot taken when the record was
 * written, so history keeps showing who it was after a rename. On a message created by an agent
 * or automation it names the person the agent acted on behalf of.
 */
export const TeamActor = Schema.Struct({
  memberId: TeamMemberId,
  name: TrimmedNonEmptyString,
});
export type TeamActor = typeof TeamActor.Type;

export const TeamMember = Schema.Struct({
  id: TeamMemberId,
  name: TrimmedNonEmptyString,
  email: Schema.optionalKey(TrimmedNonEmptyString),
  /** The environment's host. Its desktop app and startup pairing URL sign in as this member. */
  owner: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
});
export type TeamMember = typeof TeamMember.Type;

/** Who a new pairing link signs in as: an existing member, or a new one created with the link. */
export const TeamPairingMemberInput = Schema.Union([
  Schema.Struct({ memberId: TeamMemberId }),
  Schema.Struct({
    name: TrimmedNonEmptyString,
    email: Schema.optionalKey(TrimmedNonEmptyString),
  }),
]);
export type TeamPairingMemberInput = typeof TeamPairingMemberInput.Type;

export const TeamMemberUpdateInput = Schema.Struct({
  memberId: TeamMemberId,
  name: TrimmedNonEmptyString,
  /** Absent leaves the email unchanged; null clears it. */
  email: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TeamMemberUpdateInput = typeof TeamMemberUpdateInput.Type;

export const TeamMemberRemoveInput = Schema.Struct({
  memberId: TeamMemberId,
});
export type TeamMemberRemoveInput = typeof TeamMemberRemoveInput.Type;

export const TeamMemberRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  revokedSessions: Schema.Number,
});
export type TeamMemberRemoveResult = typeof TeamMemberRemoveResult.Type;

/** Shown when a session that is not tied to a team member tries to send work. */
export const TEAM_IDENTITY_REQUIRED_MESSAGE =
  "This device isn't signed in as a team member. Ask the host for a personal pairing link.";
