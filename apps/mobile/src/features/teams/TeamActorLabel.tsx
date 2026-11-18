import { teamActorAttribution } from "@t3tools/client-runtime/team-actor";
import type { OrchestrationV2Actor, TeamActor } from "@t3tools/contracts";
import { useGT } from "gt-react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** "Sent by Ada" on a member's prompt; "On behalf of Ada" on work an agent did for them. */
export function TeamActorLabel(props: {
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly actor?: TeamActor | undefined;
  readonly className?: string;
}) {
  const gt = useGT();
  const attribution = teamActorAttribution(props);
  if (attribution === null) return null;
  return (
    <Text
      numberOfLines={1}
      className={
        props.className ?? "min-w-0 shrink font-t3-medium text-xs text-foreground-secondary"
      }
    >
      {attribution.kind === "sent"
        ? gt("Sent by {name}", { name: attribution.name })
        : gt("On behalf of {name}", { name: attribution.name })}
    </Text>
  );
}
