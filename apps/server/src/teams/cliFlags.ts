import * as Option from "effect/Option";
import { Flag } from "effect/cli";

// teams: `t3 pair` and `t3 auth pairing create` bind the minted link to a team member.
export const teamMemberFlags = {
  member: Flag.String("member").pipe(
    Flag.withDescription(
      "Team member the paired client signs in as. Reuses an active member with this name, or adds one.",
    ),
    Flag.optional,
  ),
  email: Flag.String("email").pipe(
    Flag.withDescription("Email for a member that --member adds."),
    Flag.optional,
  ),
};

export const pairingLinkTeamMember = (flags: {
  readonly member: Option.Option<string>;
  readonly email: Option.Option<string>;
}) =>
  Option.match(flags.member, {
    onNone: () => ({}),
    onSome: (name) => ({
      teamMember: {
        name,
        ...Option.match(flags.email, { onNone: () => ({}), onSome: (email) => ({ email }) }),
      },
    }),
  });
