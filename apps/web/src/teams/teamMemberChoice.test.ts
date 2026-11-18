import { TeamMemberId, type TeamMember } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { initialTeamMemberChoice, isTeamOwner, toPairingMemberInput } from "./teamMemberChoice";

const member: TeamMember = {
  id: TeamMemberId.make("member-1"),
  name: "Ada",
  owner: true,
  createdAt: DateTime.makeUnsafe("2036-04-07T00:00:00.000Z"),
};

describe("toPairingMemberInput", () => {
  it("requires a pick", () => {
    expect(toPairingMemberInput(null, [member])).toBeNull();
  });

  it("refuses a member the list no longer holds", () => {
    expect(
      toPairingMemberInput({ kind: "existing", memberId: TeamMemberId.make("gone") }, [member]),
    ).toBeNull();
    expect(toPairingMemberInput({ kind: "existing", memberId: member.id }, [member])).toEqual({
      memberId: member.id,
    });
  });

  it("trims a new member and drops a blank email", () => {
    expect(toPairingMemberInput({ kind: "new", name: "  ", email: "" }, [])).toBeNull();
    expect(toPairingMemberInput({ kind: "new", name: " Bo ", email: " " }, [])).toEqual({
      name: "Bo",
    });
    expect(toPairingMemberInput({ kind: "new", name: "Bo", email: " b@x.co " }, [])).toEqual({
      name: "Bo",
      email: "b@x.co",
    });
  });
});

describe("initialTeamMemberChoice", () => {
  it("starts on a new member only when there are no members", () => {
    expect(initialTeamMemberChoice([])?.kind).toBe("new");
    expect(initialTeamMemberChoice([member])).toBeNull();
  });
});

describe("isTeamOwner", () => {
  const teammate: TeamMember = { ...member, id: TeamMemberId.make("member-2"), owner: false };
  it.each([
    ["an unidentified session", null, false],
    ["a teammate", { memberId: teammate.id, name: teammate.name }, false],
    ["the host", { memberId: member.id, name: member.name }, true],
  ] as const)("is %s the owner", (_label, sessionMember, expected) => {
    expect(isTeamOwner(sessionMember, [member, teammate])).toBe(expected);
  });
});
