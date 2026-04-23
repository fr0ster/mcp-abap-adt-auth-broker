// src/cli/publicClientEnv.ts
import {
  BTP_AUTHORIZATION_VARS,
  BTP_CONNECTION_VARS,
} from '@mcp-abap-adt/auth-stores';

export interface PublicClientEnvInput {
  abapUrl: string;
  uaaUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
}

export function renderPublicClientEnv(input: PublicClientEnvInput): string {
  const lines: string[] = [];
  lines.push(`${BTP_CONNECTION_VARS.SERVICE_URL}=${input.abapUrl}`);
  lines.push(`${BTP_AUTHORIZATION_VARS.UAA_URL}=${input.uaaUrl}`);
  lines.push(`${BTP_AUTHORIZATION_VARS.UAA_CLIENT_ID}=${input.clientId}`);
  lines.push(`${BTP_AUTHORIZATION_VARS.UAA_CLIENT_SECRET}=`);
  lines.push(`${BTP_CONNECTION_VARS.AUTHORIZATION_TOKEN}=${input.accessToken}`);
  if (input.refreshToken) {
    lines.push(
      `${BTP_AUTHORIZATION_VARS.REFRESH_TOKEN}=${input.refreshToken}`,
    );
  }
  return lines.join('\n') + '\n';
}
