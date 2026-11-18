import type { TeamActor } from "@t3tools/contracts";

/** The member a pairing link or device signs in as, in a row's secondary line. */
export function TeamMemberSummary(props: { readonly member: TeamActor | undefined }) {
  if (props.member === undefined) return null;
  return (
    <>
      {props.member.name}
      <span aria-hidden> · </span>
    </>
  );
}
