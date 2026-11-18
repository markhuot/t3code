import { TeamMemberId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { teamActorAttribution } from "./teamActor.ts";

const actor = { memberId: TeamMemberId.make("member-1"), name: "Ada" };

describe("teamActorAttribution", () => {
  it("attributes by who created the message", () => {
    expect(teamActorAttribution({ createdBy: "user", actor })).toEqual({
      kind: "sent",
      name: "Ada",
    });
    expect(teamActorAttribution({ createdBy: "agent", actor })).toEqual({
      kind: "behalf",
      name: "Ada",
    });
    expect(teamActorAttribution({ createdBy: "system", actor })).toEqual({
      kind: "behalf",
      name: "Ada",
    });
  });

  it("shows nothing for history written before teams", () => {
    expect(teamActorAttribution({ createdBy: "user" })).toBeNull();
    expect(teamActorAttribution({ actor })).toBeNull();
  });
});
