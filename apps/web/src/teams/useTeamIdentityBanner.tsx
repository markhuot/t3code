import { UserRoundXIcon } from "lucide-react";
import { useGT } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { useEnvironmentSessionState } from "~/state/session";

/** The server rejects prompts from a session that is not signed in as a team member. */
export function useTeamIdentityBanner(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const gt = useGT();
  const { data } = useEnvironmentSessionState(environmentId);
  if (data === null || !data.authenticated || data.teamMember !== null) return [];
  return [
    {
      id: "team-identity",
      variant: "warning",
      icon: <UserRoundXIcon />,
      title: gt("This device isn't signed in as a team member"),
      description: gt("Your prompts won't send. Ask the host for a personal pairing link."),
    },
  ];
}
