import type { OrchestrationV2Actor, TeamActor } from "@t3tools/contracts";

/** teams: "sent" is the person's own prompt; "behalf" is work an agent or automation did for them. */
export function teamActorAttribution(input: {
  readonly createdBy?: OrchestrationV2Actor | undefined;
  readonly actor?: TeamActor | undefined;
}): { readonly kind: "sent" | "behalf"; readonly name: string } | null {
  if (!input.actor || !input.createdBy) return null;
  return { kind: input.createdBy === "user" ? "sent" : "behalf", name: input.actor.name };
}
