import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { TeamMemberId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { makeDpopKey } from "../auth/dpop.testkit.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as Teams from "./Teams.ts";

const layerTeams = EnvironmentAuth.layer.pipe(
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (config) => ({
        ...config,
        desktopBootstrapToken: "desktop-bootstrap-token",
      })),
    ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-teams-test-" }))),
  ),
);

const requestMetadata = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

const cookieRequest = (cookieName: string, token: string) =>
  ({ cookies: { [cookieName]: token }, headers: {} }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["getSessionState"]
  >[0];

it.layer(Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer))("Teams", (it) => {
  it.effect("binds sessions to the member of the link they paired with, across renewals", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const teams = yield* Teams.Teams;

      const link = yield* auth.issuePairingCredential({ teamMember: { name: "Alex" } });
      const browser = yield* auth.createBrowserSession(link.credential, requestMetadata);
      const browserSession = yield* sessions.verify(browser.sessionToken);
      const alex = yield* teams.resolveActor(browserSession);
      expect(alex?.name).toBe("Alex");
      // Naming a member who already exists, in any case, links to them rather than a twin.
      const again = yield* auth.issuePairingCredential({ teamMember: { name: "alex" } });
      const againBrowser = yield* auth.createBrowserSession(again.credential, requestMetadata);
      expect(yield* teams.resolveActor(yield* sessions.verify(againBrowser.sessionToken))).toEqual(
        alex,
      );

      // Re-pairing the same browser with a link that names no one keeps who it is.
      const plain = yield* auth.issuePairingCredential();
      const repaired = yield* auth.createBrowserSession(
        plain.credential,
        requestMetadata,
        browser.sessionToken,
      );
      const repairedSession = yield* sessions.verify(repaired.sessionToken);
      expect(repairedSession.sessionId).not.toBe(browserSession.sessionId);
      expect(yield* teams.resolveActor(repairedSession)).toEqual(alex);

      // A DPoP device renews through T3 Connect under a new session id and subject.
      const key = makeDpopKey();
      const deviceLink = yield* auth.issuePairingCredential({
        teamMember: { memberId: alex!.memberId },
      });
      const paired = yield* auth.exchangeBootstrapCredentialForAccessToken(
        deviceLink.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const connect = yield* auth.issueConnectCredential({
        proofKeyThumbprint: key.thumbprint,
        requireApproval: false,
      });
      const renewed = yield* auth.exchangeBootstrapCredentialForAccessToken(
        connect.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const pairedSession = yield* sessions.verify(paired.access_token);
      const renewedSession = yield* sessions.verify(renewed.access_token);
      expect(renewedSession.sessionId).not.toBe(pairedSession.sessionId);
      expect(renewedSession.subject).toBe(EnvironmentAuth.CLOUD_CONNECT_SUBJECT);
      expect(yield* teams.resolveActor(renewedSession)).toEqual(alex);

      // Names are read at call time, so a rename reaches a socket that is already open.
      yield* teams.updateMember({ memberId: alex!.memberId, name: "Alexandra" });
      expect((yield* teams.resolveActor(renewedSession))?.name).toBe("Alexandra");

      const listed = yield* auth.listClientSessions(browserSession.sessionId);
      expect(
        listed.find((session) => session.sessionId === renewedSession.sessionId)?.teamMember?.name,
      ).toBe("Alexandra");
    }).pipe(Effect.provide(layerTeams)),
  );

  it.effect("resolves the host's own sessions to the owner and other unbound ones to no one", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const teams = yield* Teams.Teams;
      const owner = (yield* teams.listMembers()).find((member) => member.owner);
      expect(owner).toBeDefined();

      const desktop = yield* auth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      expect(yield* teams.resolveActor(yield* sessions.verify(desktop.access_token))).toEqual({
        memberId: owner!.id,
        name: owner!.name,
      });

      const startup = yield* auth.issueStartupPairingCredential();
      const startupBrowser = yield* auth.createBrowserSession(startup.credential, requestMetadata);
      const startupState = yield* auth.getSessionState(
        cookieRequest(sessions.cookieName, startupBrowser.sessionToken),
      );
      expect(startupState.teamMember).toEqual({ memberId: owner!.id, name: owner!.name });

      // Standard scopes include access:write, so holding them must not make a session the owner.
      const plain = yield* auth.issuePairingCredential();
      const stranger = yield* auth.createBrowserSession(plain.credential, requestMetadata);
      const strangerState = yield* auth.getSessionState(
        cookieRequest(sessions.cookieName, stranger.sessionToken),
      );
      expect(strangerState.authenticated).toBe(true);
      expect(strangerState.teamMember).toBeNull();
      // The WebSocket handler refuses work from it.
      const refused = yield* Effect.flip(
        Teams.requireSessionActor(yield* sessions.verify(stranger.sessionToken)),
      );
      expect(refused._tag).toBe("TeamIdentityRequiredError");
    }).pipe(Effect.provide(layerTeams)),
  );

  it.effect("removing a member revokes its sessions and links and refuses the owner", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const teams = yield* Teams.Teams;

      const link = yield* auth.issuePairingCredential({ teamMember: { name: "Sam" } });
      const browser = yield* auth.createBrowserSession(link.credential, requestMetadata);
      const sam = yield* teams.resolveActor(yield* sessions.verify(browser.sessionToken));
      const key = makeDpopKey();
      const deviceLink = yield* auth.issuePairingCredential({
        teamMember: { memberId: sam!.memberId },
      });
      const device = yield* auth.exchangeBootstrapCredentialForAccessToken(
        deviceLink.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const pending = yield* auth.issuePairingCredential({
        teamMember: { memberId: sam!.memberId },
      });
      const bystanderLink = yield* auth.issuePairingCredential({ teamMember: { name: "Kim" } });
      const bystander = yield* auth.createBrowserSession(bystanderLink.credential, requestMetadata);
      const lateLink = yield* auth.issuePairingCredential();
      const late = yield* auth.createBrowserSession(lateLink.credential, requestMetadata);

      expect(yield* auth.removeTeamMember(sam!.memberId)).toEqual({
        removed: true,
        revokedSessions: 2,
      });
      // A session bound to Sam after the first attempt read Sam's bindings (or a first attempt
      // that failed partway) is still revoked by a retry.
      const sql = yield* SqlClient.SqlClient;
      const lateSession = yield* sessions.verify(late.sessionToken);
      yield* sql`
        INSERT INTO team_session_members (binding_key, member_id)
        VALUES (${`sid:${lateSession.sessionId}`}, ${sam!.memberId})
      `;
      expect(yield* auth.removeTeamMember(sam!.memberId)).toEqual({
        removed: false,
        revokedSessions: 1,
      });
      expect((yield* Effect.flip(sessions.verify(late.sessionToken)))._tag).toBe(
        "SessionTokenRevokedError",
      );

      expect((yield* Effect.flip(sessions.verify(browser.sessionToken)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect((yield* Effect.flip(sessions.verify(device.access_token)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      const spent = yield* Effect.flip(
        auth.createBrowserSession(pending.credential, requestMetadata),
      );
      expect(spent._tag).toBe("ServerAuthInvalidCredentialError");
      expect(
        (yield* teams.resolveActor(yield* sessions.verify(bystander.sessionToken)))?.name,
      ).toBe("Kim");
      expect((yield* teams.listMembers()).map((member) => member.name)).not.toContain("Sam");
      expect(
        (yield* Effect.flip(
          auth.issuePairingCredential({ teamMember: { memberId: sam!.memberId } }),
        ))._tag,
      ).toBe("TeamMemberNotFoundError");

      const owner = (yield* teams.listMembers()).find((member) => member.owner);
      expect((yield* Effect.flip(teams.removeMember(owner!.id)))._tag).toBe(
        "TeamOwnerNotRemovableError",
      );
      expect((yield* Effect.flip(teams.removeMember(TeamMemberId.make("missing"))))._tag).toBe(
        "TeamMemberNotFoundError",
      );
    }).pipe(Effect.provide(layerTeams)),
  );
  it.effect(
    "a removed member's link can't pair and its T3 Connect key can't sign itself back in",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const teams = yield* Teams.Teams;
        const sql = yield* SqlClient.SqlClient;

        const key = makeDpopKey();
        const deviceLink = yield* auth.issuePairingCredential({ teamMember: { name: "Pat" } });
        const device = yield* auth.exchangeBootstrapCredentialForAccessToken(
          deviceLink.credential,
          undefined,
          requestMetadata,
          { proofKeyThumbprint: key.thumbprint },
        );
        const pat = yield* teams.resolveActor(yield* sessions.verify(device.access_token));
        expect(pat?.name).toBe("Pat");

        // The removal lands after a pairing spent Pat's link but before it bound the session.
        const racing = yield* auth.issuePairingCredential({
          teamMember: { memberId: pat!.memberId },
        });
        yield* sql`UPDATE team_members SET removed_at = ${"2026-01-01T00:00:00.000Z"} WHERE id = ${pat!.memberId}`;
        const activeBefore = (yield* auth.listSessions()).length;
        expect(
          (yield* Effect.flip(auth.createBrowserSession(racing.credential, requestMetadata)))._tag,
        ).toBe("ServerAuthInvalidCredentialError");
        expect((yield* auth.listSessions()).length).toBe(activeBefore);

        yield* auth.removeTeamMember(pat!.memberId);
        expect((yield* Effect.flip(sessions.verify(device.access_token)))._tag).toBe(
          "SessionTokenRevokedError",
        );
        // Even with device approval off, the key now waits for the host to let it back in.
        const connect = yield* auth.issueConnectCredential({
          proofKeyThumbprint: key.thumbprint,
          requireApproval: false,
        });
        expect(
          (yield* Effect.flip(
            auth.exchangeBootstrapCredentialForAccessToken(
              connect.credential,
              undefined,
              requestMetadata,
              { proofKeyThumbprint: key.thumbprint },
            ),
          ))._tag,
        ).toBe("ServerAuthConnectApprovalPendingError");
      }).pipe(Effect.provide(layerTeams)),
  );

  it.effect("a revoked device that pairs again with a link naming no one is no one", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const teams = yield* Teams.Teams;

      const host = yield* auth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      const hostSession = yield* sessions.verify(host.access_token);
      const key = makeDpopKey();
      const memberLink = yield* auth.issuePairingCredential({ teamMember: { name: "Robin" } });
      const device = yield* auth.exchangeBootstrapCredentialForAccessToken(
        memberLink.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const deviceSession = yield* sessions.verify(device.access_token);
      expect((yield* teams.resolveActor(deviceSession))?.name).toBe("Robin");

      yield* auth.revokeClientSession(hostSession.sessionId, deviceSession.sessionId);

      const plain = yield* auth.issuePairingCredential();
      const repaired = yield* auth.exchangeBootstrapCredentialForAccessToken(
        plain.credential,
        undefined,
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      expect(yield* teams.resolveActor(yield* sessions.verify(repaired.access_token))).toBe(
        undefined,
      );
    }).pipe(Effect.provide(layerTeams)),
  );
});
