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
  /** What the key store's `getAuthorizationConfig` answered (a secret client), or null. */
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

/**
 * A shipped factory's refusal: fixed words, the only ones the guard repeats.
 * Module-private, so nothing outside this file can make one.
 */
class ClientUnavailableError extends Error {
  constructor(readonly words: string) {
    super(words);
    this.name = 'ClientUnavailableError';
  }
}

const NO_CERTIFICATE = 'the destination has no client certificate';
const NO_SECRET = 'the destination has no client secret';

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
      throw new ClientUnavailableError(NO_CERTIFICATE);
    }
    const authentication = tlsClientCertificate({
      material: { cert: certificate.certificate, key: certificate.key },
      endpoint: `${certificate.certUrl.replace(/\/+$/, '')}/oauth/token`,
    });
    await authentication.tlsMaterial?.();
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
      throw new ClientUnavailableError(NO_SECRET);
    }
    return clientSecretBasic(secret, { encoding });
  };
}

/**
 * The context for one build: `readCertificate` lazy and memoised — the first
 * call reads, every later one gets the same answer.
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
    client,
    readCertificate: () => {
      certificate ??= read();
      return certificate;
    },
  };
}

/** The fixed words for what a strategy threw: only words this package owns. */
function refusalWords(error: unknown): string {
  if (error instanceof ClientUnavailableError) {
    return `the clientAuthentication strategy refused: ${error.words}`;
  }
  if (error instanceof CertificateMaterialError) {
    return `the clientAuthentication strategy refused: ${error.words.reason}`;
  }
  return 'the clientAuthentication strategy failed';
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
