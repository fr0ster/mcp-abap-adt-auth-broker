/**
 * A build's identity: everything the build read to make its provider (§6.2).
 *
 * A provider is never changed: the broker hands out the provider it built
 * while nothing that build read has changed, and builds a new one — which
 * starts with nothing — the moment anything has. "What the build read" is
 * recorded by the build itself, through one recording accessor
 * (`IdentityRecorder`): every store answer a build takes — the means, the
 * client, the certificate client, and on the consumer path the session's
 * connection and client — is handed to the builders behind a proxy that notes
 * each field read, as given. So the set of fields is each row's own, decided
 * by the code that builds it, and cannot drift from it: a field a builder
 * starts to read is part of the identity from then on.
 *
 * Every call re-reads the same sources (`StoreReads`, each at most once per
 * call) and compares each recorded field exactly (`BuildIdentity.unchanged`):
 * strings, numbers and booleans by `Object.is` — an absent value is distinct
 * from `''` — arrays and plain objects element by element.
 *
 * Secrets take part here only: a password, a client secret, a key, a subject
 * token the build read are held in memory beside the provider, which holds
 * them anyway. The identity is never logged, never persisted, and never
 * hashed into anything persisted; what a session file holds is the binding
 * record (`binding.ts`), which holds no secret.
 */

/** The store answers a build may read. */
export type SourceName =
  /** The key store's connection config: the means. */
  | 'means'
  /** The key store's authorization config: the secret client. */
  | 'client'
  /** The key store's certificate client. */
  | 'certificate'
  /** The session store's connection config (the consumer path). */
  | 'sessionConnection'
  /** The session store's authorization config (the consumer path). */
  | 'sessionClient';

/** Reads one source from its store: an object, or `null` for none. */
export type SourceReader = (name: SourceName) => Promise<object | null>;

/**
 * The error for a store answer whose `field` the broker cannot take — a
 * function, a symbol, a getter that throws: a configuration fault naming the
 * field, never its value.
 */
export type ShapeRefusal = (field: string) => unknown;

/** `IConnectionConfig`'s fields (interfaces-auth-broker). */
const CONNECTION_FIELDS = [
  'serviceUrl',
  'authorizationToken',
  'username',
  'password',
  'authType',
  'grantType',
  'expiresAt',
  'issuedFor',
  'issuedBy',
  'sapClient',
  'language',
  'sessionCookies',
  'sncPartnerName',
  'sncQop',
  'sncLib',
  'sncMyName',
  'oidcIssuerUrl',
  'oidcAuthorizationEndpoint',
  'oidcTokenEndpoint',
  'oidcDeviceAuthorizationEndpoint',
  'oidcScopes',
  'oidcSubjectToken',
  'oidcSubjectTokenType',
  'oidcAudience',
  'oidcActorToken',
  'oidcActorTokenType',
  'samlIdpSsoUrl',
  'samlIdpEntityId',
  'samlIdpCertificates',
  'samlSpEntityId',
  'samlAcsUrl',
  'samlRelayState',
  'samlIdpInitiated',
  'samlClockSkewMs',
  'samlTokenUrl',
] as const;

/** `IAuthorizationConfig`'s fields (interfaces-auth-sap). */
const AUTHORIZATION_FIELDS = [
  'uaaUrl',
  'uaaClientId',
  'uaaClientSecret',
  'refreshToken',
] as const;

/** `IClientCertificate`'s fields (interfaces-auth-broker). */
const CERTIFICATE_FIELDS = [
  'uaaUrl',
  'clientId',
  'certificate',
  'key',
  'certUrl',
] as const;

/** The contract each source answers, by its fields. */
const CONTRACT_FIELDS: Readonly<Record<SourceName, readonly string[]>> = {
  means: CONNECTION_FIELDS,
  sessionConnection: CONNECTION_FIELDS,
  client: AUTHORIZATION_FIELDS,
  sessionClient: AUTHORIZATION_FIELDS,
  certificate: CERTIFICATE_FIELDS,
};

/**
 * The sources of one call, each read from its store at most once: the
 * comparison with the cached build and — when that finds a change — the new
 * build read the same answers.
 */
export class StoreReads {
  private readonly answers = new Map<SourceName, Promise<object | null>>();

  /**
   * @param refuse The error for a field of a shape the broker cannot take.
   */
  constructor(
    private readonly reader: SourceReader,
    private readonly refuse: ShapeRefusal,
  ) {}

  read(name: SourceName): Promise<object | null> {
    let answer = this.answers.get(name);
    if (!answer) {
      // One snapshot per answer: what the builders hand their providers and
      // what the identity records are the same values, and a store that
      // changes its object afterwards — in place — changes neither.
      answer = Promise.resolve()
        .then(() => this.reader(name))
        .then((value) => snapshot(name, value, this.refuse));
      // Read by whoever asks; a failure is theirs to see, not an unhandled
      // rejection of the memo.
      answer.catch(() => {});
      this.answers.set(name, answer);
    }
    return answer;
  }
}

/** One fact a build read. */
type Entry =
  | {
      readonly source: SourceName;
      readonly kind: 'answer';
      readonly value: 'none' | 'some' | 'failed';
    }
  | {
      readonly source: SourceName;
      readonly kind: 'get';
      readonly field: string;
      readonly value: unknown;
    }
  | {
      readonly source: SourceName;
      readonly kind: 'has';
      readonly field: string;
      readonly value: boolean;
    }
  | {
      readonly source: SourceName;
      readonly kind: 'keys';
      readonly value: readonly string[];
    }
  | {
      readonly kind: 'derived';
      readonly value: unknown;
      readonly derive: (reads: StoreReads) => Promise<unknown>;
    };

/**
 * Properties a promise or a serialiser looks up on any object — awaiting an
 * answer reads its `then` — which are no field a build reads: never noted.
 */
const NOT_FIELDS: ReadonlySet<string> = new Set(['then', 'toJSON']);

/**
 * A store answer as the broker uses it: a fresh, frozen plain object holding
 * the contract's fields of the source, each read through the answer by plain
 * property access — own or inherited, a field or a getter, whatever the
 * answer's prototype — and copied deeply: arrays element by element, nested
 * objects field by field. The store's own object is never handed on, so
 * nothing the store does to it later reaches a provider built from it. A
 * field of a shape the broker cannot take is refused naming it.
 */
function snapshot(
  name: SourceName,
  answer: object | null,
  refuse: ShapeRefusal,
): object | null {
  if (answer === null || answer === undefined) return null;
  if (typeof answer !== 'object') throw refuse(name);
  const copy: Record<string, unknown> = {};
  for (const field of CONTRACT_FIELDS[name]) {
    let value: unknown;
    try {
      value = (answer as Record<string, unknown>)[field];
    } catch {
      throw refuse(field);
    }
    if (value === undefined) continue;
    copy[field] = snapshotValue(value, field, refuse, new Set());
  }
  return Object.freeze(copy);
}

/** One value of a field, copied deeply and frozen; refused when it cannot be. */
function snapshotValue(
  value: unknown,
  field: string,
  refuse: ShapeRefusal,
  seen: Set<object>,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return value;
    case 'object':
      break;
    default:
      // A function or a symbol.
      throw refuse(field);
  }
  const object = value as object;
  if (seen.has(object)) throw refuse(field);
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const length = object.length;
      const copy: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        copy.push(snapshotValue(object[i], field, refuse, seen));
      }
      return Object.freeze(copy);
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(object)) {
      copy[key] = snapshotValue(
        (object as Record<string, unknown>)[key],
        field,
        refuse,
        seen,
      );
    }
    return Object.freeze(copy);
  } catch {
    // A getter or a proxy that threw inside the value, or a part of it of a
    // shape the broker cannot take: the field's fault, whatever was thrown.
    throw refuse(field);
  } finally {
    seen.delete(object);
  }
}

/** A copy of a value as read: arrays and plain objects copied, element by element. */
function copied(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copied);
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = copied(value[key]);
    return copy;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Exact equality of two values as read: `Object.is` for everything but arrays
 * and plain objects, which are equal element by element (and key by key).
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((element, i) => sameValue(element, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a).sort();
    const others = Object.keys(b).sort();
    if (!sameValue(keys, others)) return false;
    return keys.every((key) => sameValue(a[key], b[key]));
  }
  return Object.is(a, b);
}

/** The own string keys of an answer, in a fixed order. */
function keysOf(target: object): string[] {
  return Object.keys(target).sort();
}

/**
 * The one recording accessor of a build: every source the build reads goes
 * through `read`, and every field read of what it answers — a property read,
 * an `in` test, an enumeration — is noted, once, as given. `seal()` ends the
 * recording: what is read afterwards is not the build's.
 */
export class IdentityRecorder {
  private readonly entries: Entry[] = [];
  private readonly noted = new Set<string>();
  private sealed = false;

  /** @param reads The call's reads, which every recorded source goes through. */
  constructor(readonly reads: StoreReads) {}

  /**
   * The source's answer, behind the recording proxy, or `null`. A read that
   * fails is noted as failed and rethrown.
   */
  async read<T extends object>(name: SourceName): Promise<T | null> {
    let answer: object | null;
    try {
      answer = await this.reads.read(name);
    } catch (error) {
      this.note(`${name}`, { source: name, kind: 'answer', value: 'failed' });
      throw error;
    }
    this.note(`${name}`, {
      source: name,
      kind: 'answer',
      value: answer ? 'some' : 'none',
    });
    return answer ? (this.watched(name, answer) as T) : null;
  }

  /**
   * Notes a value the build derived from sources it reads without the
   * recording proxy, with how to derive it again from a later call's reads.
   * For sources whose answers change for reasons that are no change of the
   * means — the session store's, which the broker's own writes change: the
   * identity is what the build took from them, never what else they hold.
   */
  derived(
    value: unknown,
    derive: (reads: StoreReads) => Promise<unknown>,
  ): void {
    if (this.sealed) return;
    this.entries.push({ kind: 'derived', value: copied(value), derive });
  }

  /** The identity as read so far; nothing read later is recorded. */
  seal(): BuildIdentity {
    this.sealed = true;
    return new BuildIdentity([...this.entries]);
  }

  private note(key: string, entry: Entry): void {
    if (this.sealed || this.noted.has(key)) return;
    this.noted.add(key);
    this.entries.push(entry);
  }

  private watched(source: SourceName, target: object): object {
    return new Proxy(target, {
      get: (object, property) => {
        const value: unknown = Reflect.get(object, property);
        if (typeof property === 'string' && !NOT_FIELDS.has(property)) {
          this.note(`${source}.get.${property}`, {
            source,
            kind: 'get',
            field: property,
            value: copied(value),
          });
        }
        return value;
      },
      has: (object, property) => {
        const value = Reflect.has(object, property);
        if (typeof property === 'string' && !NOT_FIELDS.has(property)) {
          this.note(`${source}.has.${property}`, {
            source,
            kind: 'has',
            field: property,
            value,
          });
        }
        return value;
      },
      ownKeys: (object) => {
        this.note(`${source}.keys`, {
          source,
          kind: 'keys',
          value: keysOf(object),
        });
        return Reflect.ownKeys(object);
      },
    });
  }
}

/**
 * What one build read, sealed: compared with a fresh read of the same
 * sources on every call. Holds secrets the build read, in memory only.
 */
export class BuildIdentity {
  constructor(private readonly entries: readonly Entry[]) {}

  /**
   * Whether every fact this build read is still what the stores answer —
   * each source re-read through `reads` (once per call), each field compared
   * exactly. A source that cannot be read now, where it could then, is a
   * change: the new build meets the failure itself.
   */
  async unchanged(reads: StoreReads): Promise<boolean> {
    const answers = new Map<SourceName, object | null | 'failed'>();
    for (const entry of this.entries) {
      if (entry.kind === 'derived') {
        const now = await entry.derive(reads).then(
          (value) => ({ value }),
          () => undefined,
        );
        if (!now || !sameValue(entry.value, now.value)) return false;
        continue;
      }
      let answer = answers.get(entry.source);
      if (answer === undefined) {
        answer = await reads.read(entry.source).then(
          (value) => value,
          () => 'failed' as const,
        );
        answers.set(entry.source, answer);
      }
      if (!sameFact(entry, answer)) return false;
    }
    return true;
  }
}

function sameFact(
  entry: Exclude<Entry, { kind: 'derived' }>,
  answer: object | null | 'failed',
): boolean {
  if (entry.kind === 'answer') {
    const now = answer === 'failed' ? 'failed' : answer ? 'some' : 'none';
    return entry.value === now;
  }
  if (answer === null || answer === 'failed') return false;
  switch (entry.kind) {
    case 'get':
      return sameValue(entry.value, Reflect.get(answer, entry.field));
    case 'has':
      return entry.value === Reflect.has(answer, entry.field);
    case 'keys':
      return sameValue(entry.value, keysOf(answer));
  }
}
