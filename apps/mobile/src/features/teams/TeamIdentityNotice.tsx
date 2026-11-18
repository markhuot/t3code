import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { environmentSession } from "../../state/session";

/** A teams host sends `teamMember: null` and refuses prompts from that device; other hosts omit it. */
export function TeamIdentityNotice(props: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const session = AsyncResult.getOrElse(
    useAtomValue(environmentSession.sessionStateAtom(props.environmentId)),
    () => null,
  );
  if (session?.authenticated !== true || session.teamMember !== null) return null;
  return (
    <View className="px-4 pb-3">
      <Notice
        message={gt(
          "This device isn't signed in as a team member. Ask the host for a personal pairing link.",
        )}
        icon="exclamationmark.circle"
        floating
      />
    </View>
  );
}
