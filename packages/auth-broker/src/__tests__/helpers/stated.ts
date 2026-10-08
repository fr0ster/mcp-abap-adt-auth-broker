/**
 * The choices auth-broker 5 requires of every broker that builds or serves a
 * token destination, stated once for the suites that are not about them:
 * renew as 4.x did (one refresh, then one login) and fail the call whose
 * session write did not land. The suites about these options
 * (`renewal.test.ts`, `errors.test.ts`) state their own.
 */

import { refreshThenLogin } from '@mcp-abap-adt/auth-providers';
import type { AuthBrokerConfig } from '../../AuthBroker';

export const STATED = {
  renewal: () => refreshThenLogin(),
  onWriteFailure: 'fail',
} as const satisfies Pick<AuthBrokerConfig, 'renewal' | 'onWriteFailure'>;
