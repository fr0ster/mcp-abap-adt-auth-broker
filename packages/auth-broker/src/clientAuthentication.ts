/**
 * How a destination's client authenticates to the authorization server — the
 * consumer's choice, as a strategy (`AuthBrokerConfig.clientAuthentication`).
 *
 * The broker ships two factories, each failing closed: one answers the
 * certificate the key store holds, one the secret. Neither falls back to the
 * other; a consumer that wants a fallback composes it, and its order is the
 * consumer's statement. Whatever a strategy throws, the broker turns into a
 * `DestinationConfigError` in fixed words (`resolveClientAuthentication`) —
 * nothing of the thrown value, no `cause`.
 */

import {
  CertificateMaterialError,
  clientSecretBasic,
  tlsClientCertificate,
} from '@mcp-abap-adt/auth-providers';
import type { IClientAuthentication } from '@mcp-abap-adt/interfaces-auth';
import type { IClientCertificate } from '@mcp-abap-adt/interfaces-auth-broker';
import type { IAuthorizationConfig } from '@mcp-abap-adt/interfaces-auth-sap';
import { DestinationConfigError } from './DestinationConfigError';

/**
 * Every grant whose client authenticates to the authorization server: the
 * three UAA grants, the OIDC grants and `saml2_bearer`. (`saml2_pure` and the
 * basic, SNC and handed-over rows authenticate no client and never call the
 * strategy.)
 */
export type ClientAuthenticationGrant =
  | 'client_credentials'
  | 'authorization_code'
  | 'passcode'
  | 'oidc_authorization_code'
  | 'device_code'
  | 'password'
  | 'token_exchange'
  | 'saml2_bearer';

/** What a strategy is given, once per build of a destination's provider. */
export interface ClientAuthenticationContext {
  readonly destination: string;
  readonly grant: ClientAuthenticationGrant;
  /**
   * The secret client the key store's `getAuthorizationConfig` answered —
   * `uaaUrl`, `uaaClientId`, `uaaClientSecret` only, never a refresh token —
   * or null.
   */
  readonly client: IAuthorizationConfig | null;
  /**
   * The key store's certificate client, read only when called and at most
   * once per build; `null` when the store has none or implements no
   * `getClientCertificate`.
   */
  readCertificate(): Promise<IClientCertificate | null>;
}

/** The strategy `AuthBrokerConfig.clientAuthentication` takes. */
export type ClientAuthenticationStrategy = (
  context: ClientAuthenticationContext,
) => Promise<IClientAuthentication>;

const NO_CERTIFICATE = 'the destination has no client certificate';
const NO_SECRET = 'the destination has no client secret';

/**
 * A shipped factory's refusal. Module-private, so nothing outside this file
 * can make one — but a consumer composing a factory can catch and alter it,
 * so the guard reads only `missing` and picks the words itself.
 */
class ClientUnavailableError extends Error {
  constructor(readonly missing: 'certificate' | 'secret') {
    super(missing === 'certificate' ? NO_CERTIFICATE : NO_SECRET);
    this.name = 'ClientUnavailableError';
  }
}

/** The broker's words for auth-providers' CertificateMaterialError, by its flags. */
const CERTIFICATE_INCOMPLETE = 'the client certificate is incomplete';
const CERTIFICATE_EXPIRED = 'the client certificate has expired';
const CERTIFICATE_UNUSABLE = 'the client certificate could not be used';

/**
 * `tls_client_auth` with the certificate and key the key store holds, against
 * `${certUrl}/oauth/token`. The material is handed over as given and checked
 * before the factory answers — auth-providers checks it only on first use, so
 * a malformed, incomplete or expired PEM would otherwise surface only at the
 * first token request, in a provider already built and cached.
 *
 * Throws "the destination has no client certificate" when the store answers
 * `null` or implements no `getClientCertificate`.
 */
export function fromServiceKeyCertificate(): ClientAuthenticationStrategy {
  return async (context) => {
    const certificate = await context.readCertificate();
    if (!certificate) {
      throw new ClientUnavailableError('certificate');
    }
    const authentication = tlsClientCertificate({
      material: { cert: certificate.certificate, key: certificate.key },
      endpoint: `${certificate.certUrl.replace(/\/+$/, '')}/oauth/token`,
    });
    if (typeof authentication.tlsMaterial !== 'function') {
      throw new ClientUnavailableError('certificate');
    }
    await authentication.tlsMaterial();
    return authentication;
  };
}

/** How `fromServiceKeySecret` writes the client id and secret. */
export interface FromServiceKeySecretOptions {
  /**
   * `'raw'`: `base64(id:secret)` as given — XSUAA accepts only this
   * (measured). `'form'`: each component form-encoded first (RFC 6749
   * §2.3.1) — UAA, Keycloak. Required: it depends on the server.
   */
  readonly encoding: 'raw' | 'form';
}

/**
 * `client_secret_basic` with the secret client the key store holds.
 *
 * Throws "the destination has no client secret" when the store answers no
 * secret client, or one with an empty secret. A missing or unknown `encoding`
 * is refused when the factory is made.
 */
export function fromServiceKeySecret(
  options: FromServiceKeySecretOptions,
): ClientAuthenticationStrategy {
  const encoding = options?.encoding;
  if (encoding !== 'raw' && encoding !== 'form') {
    throw new TypeError(
      "fromServiceKeySecret: encoding must be 'raw' or 'form'",
    );
  }
  return async (context) => {
    const secret = context.client?.uaaClientSecret;
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new ClientUnavailableError('secret');
    }
    return clientSecretBasic(secret, { encoding });
  };
}

/**
 * What a strategy is told of the secret client: an allowlist — who it is
 * (`uaaUrl`, `uaaClientId`) and its secret (`uaaClientSecret`, which
 * `fromServiceKeySecret` sends) — never a refresh token or any other field a
 * store's `getAuthorizationConfig` carried, which no binding has checked.
 */
export function contextClient(
  client: IAuthorizationConfig | null,
): IAuthorizationConfig | null {
  if (!client) return null;
  return {
    uaaUrl: client.uaaUrl,
    uaaClientId: client.uaaClientId,
    uaaClientSecret: client.uaaClientSecret,
  };
}

/**
 * The certificate client as the contract declares it — `uaaUrl`, `clientId`,
 * `certificate`, `key`, `certUrl` — and nothing else a store answered with it.
 */
function certificateOf(
  answer: IClientCertificate | null,
): IClientCertificate | null {
  if (!answer) return null;
  return {
    uaaUrl: answer.uaaUrl,
    clientId: answer.clientId,
    certificate: answer.certificate,
    key: answer.key,
    certUrl: answer.certUrl,
  };
}

/**
 * The context for one build: the client through `contextClient`;
 * `readCertificate` lazy and memoised — the first call reads, every later one
 * gets the same answer.
 */
export function clientAuthenticationContext(
  destination: string,
  grant: ClientAuthenticationGrant,
  client: IAuthorizationConfig | null,
  read: () => Promise<IClientCertificate | null>,
): ClientAuthenticationContext {
  let certificate: Promise<IClientCertificate | null> | undefined;
  return {
    destination,
    grant,
    client: contextClient(client),
    readCertificate: () => {
      certificate ??= read().then(certificateOf);
      return certificate;
    },
  };
}

const FAILED = 'the clientAuthentication strategy failed';
const REFUSED = 'the clientAuthentication strategy refused';

/**
 * The fixed words for what a strategy threw. Every word is this module's own:
 * the thrown value only selects among them, through `instanceof` and flags
 * compared with `===` — never a message, never its `words`. Classifying may
 * itself throw (a Proxy, a getter), so it runs in its own try and falls back
 * to the generic words.
 */
function refusalWords(error: unknown): string {
  try {
    if (error instanceof ClientUnavailableError) {
      const missing = error.missing;
      if (missing === 'certificate') return `${REFUSED}: ${NO_CERTIFICATE}`;
      if (missing === 'secret') return `${REFUSED}: ${NO_SECRET}`;
      return FAILED;
    }
    if (error instanceof CertificateMaterialError) {
      if (error.incomplete === true) {
        return `${REFUSED}: ${CERTIFICATE_INCOMPLETE}`;
      }
      if (error.expired === true) return `${REFUSED}: ${CERTIFICATE_EXPIRED}`;
      return `${REFUSED}: ${CERTIFICATE_UNUSABLE}`;
    }
  } catch {
    // Fall through: the thrown value could not even be classified.
  }
  return FAILED;
}

/**
 * Runs the strategy inside the guard. Any throw — the strategy's own, a
 * store's, a malformed PEM — and any answer that is no client authentication
 * becomes a `DestinationConfigError` naming `clientAuthentication`, in fixed
 * words: no `cause`, nothing of the thrown value.
 */
export async function resolveClientAuthentication(
  strategy: ClientAuthenticationStrategy,
  context: ClientAuthenticationContext,
): Promise<IClientAuthentication> {
  let answer: unknown;
  let usable: boolean;
  try {
    answer = await strategy(context);
    // Read inside the guard: a getter on the answer may throw too.
    usable =
      typeof answer === 'object' &&
      answer !== null &&
      typeof (answer as IClientAuthentication).authenticate === 'function';
  } catch (error) {
    throw new DestinationConfigError(
      context.destination,
      ['clientAuthentication'],
      refusalWords(error),
    );
  }
  if (!usable) {
    throw new DestinationConfigError(
      context.destination,
      ['clientAuthentication'],
      'the clientAuthentication strategy answered no client authentication',
    );
  }
  return answer as IClientAuthentication;
}

/**
 * Who the client is — its authorization server and client id — and nothing
 * else: no secret field, so it can never be taken for a (public) secret
 * client, and never PEM.
 */
export interface ClientIdentity {
  readonly uaaUrl: string;
  readonly uaaClientId: string;
}

/**
 * The client identity a strategy-authenticated row and its binding take: the
 * secret client's `uaaUrl` and `uaaClientId` when the key store has one, else
 * the certificate client's `uaaUrl` and `clientId` — read through the
 * context's memoised `readCertificate`, so at most once per build — else
 * `null`. The secret stays behind: beside a strategy a row passes none.
 *
 * A failing read is a `DestinationConfigError` naming `clientAuthentication`
 * in fixed words — nothing of what the store threw, no `cause`.
 */
export async function clientIdentity(
  context: ClientAuthenticationContext,
): Promise<ClientIdentity | null> {
  const client = context.client;
  if (client) {
    return { uaaUrl: client.uaaUrl, uaaClientId: client.uaaClientId };
  }
  let certificate: IClientCertificate | null;
  try {
    certificate = await context.readCertificate();
  } catch {
    throw new DestinationConfigError(
      context.destination,
      ['clientAuthentication'],
      'the client certificate could not be read',
    );
  }
  if (!certificate) return null;
  return { uaaUrl: certificate.uaaUrl, uaaClientId: certificate.clientId };
}
