import type { EnvironmentId, TeamMember } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { authEnvironment } from "~/state/auth";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "~/components/settings/itemRows";
import { SettingsSection } from "~/components/settings/settingsLayout";

function TeamMemberRow(props: {
  readonly environmentId: EnvironmentId;
  readonly member: TeamMember;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  const { member } = props;
  const updateTeamMember = useAtomCommand(authEnvironment.updateTeamMember, {
    reportFailure: false,
  });
  const removeTeamMember = useAtomCommand(authEnvironment.removeTeamMember, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [busy, setBusy] = useState(false);

  const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : undefined,
      }),
    );
  };

  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed === member.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const result = await updateTeamMember({
      environmentId: props.environmentId,
      input: {
        memberId: member.id,
        name: trimmed,
        ...(member.email === undefined ? {} : { email: member.email }),
      },
    });
    setBusy(false);
    if (result._tag === "Success") setEditing(false);
    else reportFailure(gt("Could not rename team member"), result);
  };

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      gt(
        "Remove {name}? This signs out all of their devices and cancels their unused pairing links. Past messages keep their name.",
        {
          name: member.name,
        },
      ),
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await removeTeamMember({
      environmentId: props.environmentId,
      input: { memberId: member.id },
    });
    setBusy(false);
    reportFailure(gt("Could not remove team member"), result);
  };

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          {editing ? (
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void save();
                if (event.key === "Escape") {
                  setName(member.name);
                  setEditing(false);
                }
              }}
              aria-label={gt("Name")}
              disabled={busy}
              autoFocus
            />
          ) : (
            <div className="flex min-h-5 items-center gap-1.5">
              <h3 className="text-sm font-medium text-foreground">{member.name}</h3>
              {member.owner ? (
                <Badge variant="outline" size="sm">
                  {gt("Owner")}
                </Badge>
              ) : null}
            </div>
          )}
          {member.email !== undefined && !editing ? (
            <p className="text-xs text-muted-foreground">{member.email}</p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {editing ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setName(member.name);
                  setEditing(false);
                }}
              >
                {gt("Cancel")}
              </Button>
              <Button size="xs" disabled={busy || name.trim() === ""} onClick={() => void save()}>
                {gt("Save")}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={!props.canWrite || busy}
                onClick={() => {
                  setName(member.name);
                  setEditing(true);
                }}
              >
                {gt("Rename")}
              </Button>
              {member.owner ? null : (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  disabled={!props.canWrite || busy}
                  onClick={() => void remove()}
                >
                  {gt("Remove")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Members come from the access snapshot, which the server resends whenever they change. */
export function TeamMembersSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly members: ReadonlyArray<TeamMember>;
  readonly canWrite: boolean;
}) {
  const gt = useGT();
  return (
    <SettingsSection id="team-members" title={gt("Team members")}>
      {props.members.map((member) => (
        <TeamMemberRow
          key={member.id}
          environmentId={props.environmentId}
          member={member}
          canWrite={props.canWrite}
        />
      ))}
      {props.members.length === 0 ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground/60">
            {gt("No team members yet. Create a pairing link to add one.")}
          </p>
        </div>
      ) : null}
    </SettingsSection>
  );
}
