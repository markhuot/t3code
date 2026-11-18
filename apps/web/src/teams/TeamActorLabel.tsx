import { teamActorAttribution } from "@t3tools/client-runtime/team-actor";
import type { OrchestrationV2Actor, TeamActor } from "@t3tools/contracts";
import { useGT } from "gt-react";

/** Who sent a prompt, or on whose behalf an agent or automation did. Nothing for pre-teams history. */
export function TeamActorLabel(props: {
  readonly message: {
    readonly createdBy?: OrchestrationV2Actor | undefined;
    readonly actor?: TeamActor | undefined;
  };
}) {
  const gt = useGT();
  const attribution = teamActorAttribution(props.message);
  if (attribution === null) return null;
  const { name } = attribution;
  return (
    <p className="me-1 text-2xs text-muted-foreground/70" data-team-actor={attribution.kind}>
      {attribution.kind === "sent"
        ? gt("Sent by {name}", { name })
        : gt("On behalf of {name}", { name })}
    </p>
  );
}
