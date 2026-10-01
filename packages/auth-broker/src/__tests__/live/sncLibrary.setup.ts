/**
 * Whether an SNC library is installed here, decided before the live suite is
 * collected: Jest decides what to skip while it collects, synchronously, and
 * finding the library is not (the Windows registry, file headers). The answer
 * goes to the suite in `AUTH_BROKER_LIVE_SNC_LIBRARY`: empty when one is found,
 * else why not — the same search `SncLogonProvider` runs at logon
 * (`DefaultSncLibraryLocator`), the destination's own `sncLib` first.
 */
import {
  DefaultSncLibraryLocator,
  nodeSncSystem,
} from '@mcp-abap-adt/auth-providers';
import { EnvDestinationStore } from 'auth-stores-3';

export const SNC_LIBRARY_VARIABLE = 'AUTH_BROKER_LIVE_SNC_LIBRARY';

export default async function sncLibrarySetup(): Promise<void> {
  const keysDir = process.env.AUTH_BROKER_LIVE_KEYS_DIR;
  const destination = process.env.AUTH_BROKER_LIVE_SNC_DESTINATION;
  const onItsPlatform =
    process.platform === 'win32' || process.platform === 'darwin';
  // Nothing to look for: the suite's own guards name what is missing.
  if (!onItsPlatform || !keysDir || !destination) return;

  let sncLib: string | undefined;
  try {
    const means = await new EnvDestinationStore(keysDir).getConnectionConfig(
      destination,
    );
    sncLib = means?.sncLib;
  } catch {
    // The suite reads the destination itself and fails there with the cause.
  }
  try {
    await new DefaultSncLibraryLocator(nodeSncSystem(), sncLib).locate();
    process.env[SNC_LIBRARY_VARIABLE] = '';
  } catch (error) {
    const tried = (error as { tried?: { source: string; reason: string }[] })
      .tried;
    const where = tried?.length
      ? tried.map((t) => `${t.source}: ${t.reason}`).join('; ')
      : 'no candidate (SNC_LIB_64, SNC_LIB, the registry or the macOS bundle)';
    process.env[SNC_LIBRARY_VARIABLE] =
      `no SNC library installed here — the SAP Secure Login Client (or another SNC product) is needed (${where})`;
  }
}
