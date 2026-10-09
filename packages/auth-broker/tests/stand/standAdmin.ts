/**
 * What the stand's SAML suites set up on its two servers at run time, shared
 * by the library's suites (src/__tests__/stand) and the CLI's
 * (packages/auth-broker-cli/src/__tests__/stand) — reused, never copied:
 *
 * - UAA trusts Keycloak as its `keycloak` SAML identity provider, from the
 *   metadata Keycloak publishes (its keys are generated per start, so never a
 *   committed fixture);
 * - UAA's own ACS per binding, read from its SAML metadata — never derived
 *   from the URL a suite was given, whose port may differ from the committed
 *   configuration;
 * - a Keycloak SAML client's attributes changed through the admin API: the
 *   IdP-initiated SSO target of `uaa-sp`, and assertions valid for an hour —
 *   by default Keycloak's `Conditions` expire a minute after issue, inside the
 *   one-minute margin a provider keeps.
 *
 * Test-only: it ships in no package. Every value here is the local stand's
 * committed fixture (`stand_admin` / `secret`, Keycloak's `admin` / `admin`).
 */

const basic = (client: string) =>
  `Basic ${Buffer.from(`${client}:secret`).toString('base64')}`;

/** Register — or refresh — Keycloak as UAA's `keycloak` SAML provider. */
export async function trustKeycloakInUaa(
  uaaUrl: string,
  keycloakUrl: string,
): Promise<void> {
  const metadata = await (
    await fetch(`${keycloakUrl}/protocol/saml/descriptor`)
  ).text();
  const token = (
    (await (
      await fetch(`${uaaUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: basic('stand_admin'),
        },
        body: 'grant_type=client_credentials',
      })
    ).json()) as { access_token: string }
  ).access_token;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const provider = {
    type: 'saml',
    originKey: 'keycloak',
    name: 'keycloak',
    active: true,
    config: {
      metaDataLocation: metadata,
      idpEntityAlias: 'keycloak',
      nameID: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
      assertionConsumerIndex: 0,
      metadataTrustCheck: false,
      showSamlLink: false,
      addShadowUserOnLogin: true,
    },
  };
  const existing = (
    (await (
      await fetch(`${uaaUrl}/identity-providers?rawConfig=true`, { headers })
    ).json()) as { id: string; originKey: string }[]
  ).find((p) => p.originKey === 'keycloak');
  const response = await fetch(
    existing
      ? `${uaaUrl}/identity-providers/${existing.id}?rawConfig=true`
      : `${uaaUrl}/identity-providers?rawConfig=true`,
    {
      method: existing ? 'PUT' : 'POST',
      headers,
      body: JSON.stringify(
        existing ? { ...provider, id: existing.id } : provider,
      ),
    },
  );
  if (!response.ok) {
    throw new Error(`UAA refused the Keycloak provider: ${response.status}`);
  }
}

/** UAA's ACS for a binding, from its own SAML metadata. */
export async function uaaAcs(
  uaaUrl: string,
  binding: 'HTTP-POST' | 'URI',
): Promise<string> {
  const metadata = await (await fetch(`${uaaUrl}/saml/metadata`)).text();
  const acs = new RegExp(
    `AssertionConsumerService[^>]*bindings:${binding}"[^>]*Location="([^"]+)"`,
  ).exec(metadata)?.[1];
  if (!acs) throw new Error(`no ${binding}-binding ACS in UAA metadata`);
  return acs;
}

/**
 * Merge `attributes` into the attributes of the `test` realm's SAML client
 * `clientId`, through Keycloak's admin API.
 */
export async function updateKeycloakSamlClient(
  keycloakUrl: string,
  clientId: string,
  attributes: Record<string, string>,
): Promise<void> {
  const base = keycloakUrl.replace(/\/realms\/.*$/, '');
  const admin = (
    (await (
      await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'admin',
        }),
      })
    ).json()) as { access_token: string }
  ).access_token;
  const headers = {
    Authorization: `Bearer ${admin}`,
    'Content-Type': 'application/json',
  };
  const [client] = (await (
    await fetch(
      `${base}/admin/realms/test/clients?clientId=${encodeURIComponent(clientId)}`,
      { headers },
    )
  ).json()) as { id: string; attributes: Record<string, string> }[];
  if (!client) throw new Error(`Keycloak has no ${clientId} client`);
  client.attributes = { ...client.attributes, ...attributes };
  const updated = await fetch(
    `${base}/admin/realms/test/clients/${client.id}`,
    { method: 'PUT', headers, body: JSON.stringify(client) },
  );
  if (!updated.ok) {
    throw new Error(`Keycloak refused the client update: ${updated.status}`);
  }
}

/** Assertions of a Keycloak SAML client valid for an hour. */
export const HOUR_LONG_ASSERTIONS = { 'saml.assertion.lifespan': '3600' };

/**
 * Point Keycloak's `uaa-sp` client's IdP-initiated SSO at `acsUrl`, with
 * assertions valid for an hour, and return the URL that starts it.
 */
export async function idpInitiatedSsoTo(
  keycloakUrl: string,
  acsUrl: string,
): Promise<string> {
  await updateKeycloakSamlClient(keycloakUrl, 'uaa-sp', {
    saml_idp_initiated_sso_url_name: 'uaa-sp',
    saml_assertion_consumer_url_post: acsUrl,
    ...HOUR_LONG_ASSERTIONS,
  });
  return `${keycloakUrl}/protocol/saml/clients/uaa-sp`;
}
