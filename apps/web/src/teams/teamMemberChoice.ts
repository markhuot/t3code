import type { TeamActor, TeamMember, TeamPairingMemberInput } from "@t3tools/contracts";

/** Only the host binds links to members and manages them; the server refuses anyone else. */
export function isTeamOwner(
  sessionMember: TeamActor | null | undefined,
  members: ReadonlyArray<TeamMember>,
): boolean {
  if (sessionMember == null) return false;
  return members.some((member) => member.owner && member.id === sessionMember.memberId);
}

/** Who a new pairing link is for: nothing picked yet, an existing member, or a new one. */
export type TeamMemberChoice =
  | { readonly kind: "existing"; readonly memberId: TeamMember["id"] }
  | { readonly kind: "new"; readonly name: string; readonly email: string };

export const NEW_TEAM_MEMBER_CHOICE: TeamMemberChoice = { kind: "new", name: "", email: "" };

/** With no members yet the only option is a new one, so start there. */
export function initialTeamMemberChoice(
  members: ReadonlyArray<TeamMember>,
): TeamMemberChoice | null {
  return members.length === 0 ? NEW_TEAM_MEMBER_CHOICE : null;
}

/** The wire input for a choice, or null while it is incomplete. */
export function toPairingMemberInput(
  choice: TeamMemberChoice | null,
  members: ReadonlyArray<TeamMember>,
): TeamPairingMemberInput | null {
  if (choice === null) return null;
  if (choice.kind === "existing") {
    return members.some((member) => member.id === choice.memberId)
      ? { memberId: choice.memberId }
      : null;
  }
  const name = choice.name.trim();
  if (name === "") return null;
  const email = choice.email.trim();
  return email === "" ? { name } : { name, email };
}
