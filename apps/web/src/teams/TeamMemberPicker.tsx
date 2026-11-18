import type { TeamMember } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { NEW_TEAM_MEMBER_CHOICE, type TeamMemberChoice } from "./teamMemberChoice";

const NEW_VALUE = "\u0000new";

/** Who a pairing link signs in as: an existing member, or a new one created with the link. */
export function TeamMemberPicker(props: {
  readonly members: ReadonlyArray<TeamMember>;
  readonly choice: TeamMemberChoice | null;
  readonly onChange: (choice: TeamMemberChoice | null) => void;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const { choice } = props;
  const value = choice === null ? null : choice.kind === "new" ? NEW_VALUE : choice.memberId;
  const label =
    choice === null
      ? gt("Choose a team member")
      : choice.kind === "new"
        ? gt("New member")
        : (props.members.find((member) => member.id === choice.memberId)?.name ??
          gt("Choose a team member"));
  return (
    <section className="space-y-2">
      <span className="block text-xs font-medium text-foreground">{gt("Team member")}</span>
      <p className="text-xs text-muted-foreground">
        {gt("Prompts from the paired device are sent as this person.")}
      </p>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === NEW_VALUE) {
            props.onChange(choice?.kind === "new" ? choice : NEW_TEAM_MEMBER_CHOICE);
          } else {
            const member = props.members.find((candidate) => candidate.id === next);
            if (member) props.onChange({ kind: "existing", memberId: member.id });
          }
        }}
      >
        <SelectTrigger aria-label={gt("Team member")} disabled={props.disabled}>
          <SelectValue>{label}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {props.members.map((member) => (
            <SelectItem key={member.id} value={member.id}>
              {member.name}
            </SelectItem>
          ))}
          <SelectItem value={NEW_VALUE}>{gt("New member")}</SelectItem>
        </SelectPopup>
      </Select>
      {choice?.kind === "new" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={choice.name}
            onChange={(event) => props.onChange({ ...choice, name: event.target.value })}
            placeholder={gt("Name")}
            aria-label={gt("Name")}
            disabled={props.disabled}
          />
          <Input
            type="email"
            value={choice.email}
            onChange={(event) => props.onChange({ ...choice, email: event.target.value })}
            placeholder={gt("Email (optional)")}
            aria-label={gt("Email (optional)")}
            disabled={props.disabled}
          />
        </div>
      ) : null}
    </section>
  );
}
