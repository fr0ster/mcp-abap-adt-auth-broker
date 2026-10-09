// Rule 6: a builder call with diagnostics, where no diagnostic site is
// approved. Must be found.
import { authError } from '@mcp-abap-adt/auth-errors';

export function withLibrary() {
  return authError.snc<'no-credential'>(
    { problem: 'no-credential' },
    { library: '/opt/libsapcrypto.so' },
  );
}
