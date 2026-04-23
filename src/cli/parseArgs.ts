// src/cli/parseArgs.ts
export interface McpAuthOptions {
  mode: 'service-key' | 'public-client';
  // service-key mode
  serviceKeyPath?: string;
  envFilePath?: string;
  authType: 'abap' | 'xsuaa';
  credential: boolean;
  // public-client mode
  abapUrl?: string;
  uaaUrl?: string;
  clientId?: string;
  // common
  outputFile: string;
  browser: string;
  format: 'json' | 'env';
  serviceUrl?: string;
  redirectPort?: number;
}

export function parseArgs(args: string[]): McpAuthOptions {
  let serviceKeyPath: string | undefined;
  let envFilePath: string | undefined;
  let outputFile: string | undefined;
  let abapUrl: string | undefined;
  let uaaUrl: string | undefined;
  let clientId: string | undefined;
  let authType: 'abap' | 'xsuaa' = 'abap';
  let browser = 'auto';
  let credential = false;
  let format: 'json' | 'env' = 'env';
  let serviceUrl: string | undefined;
  let redirectPort: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--service-key':
        serviceKeyPath = next();
        break;
      case '--env':
        envFilePath = next();
        break;
      case '--output':
        outputFile = next();
        break;
      case '--abap-url':
        abapUrl = next();
        break;
      case '--uaa-url':
        uaaUrl = next();
        break;
      case '--client-id':
        clientId = next();
        break;
      case '--type': {
        const t = next();
        if (t !== 'abap' && t !== 'xsuaa') {
          throw new Error(`Invalid auth type: ${t}. Must be 'abap' or 'xsuaa'`);
        }
        authType = t;
        break;
      }
      case '--browser': {
        const b = next();
        const allowed = [
          'none',
          'chrome',
          'edge',
          'firefox',
          'system',
          'headless',
          'auto',
        ];
        if (!allowed.includes(b)) {
          throw new Error(
            `Invalid browser: ${b}. Must be one of: ${allowed.join(', ')}`,
          );
        }
        browser = b;
        break;
      }
      case '--format': {
        const f = next();
        if (f !== 'json' && f !== 'env') {
          throw new Error(`Invalid format: ${f}. Must be 'json' or 'env'`);
        }
        format = f;
        break;
      }
      case '--service-url':
        serviceUrl = next();
        break;
      case '--redirect-port': {
        const p = parseInt(next(), 10);
        if (Number.isNaN(p) || p < 1 || p > 65535) {
          throw new Error(`Invalid redirect port. Must be 1..65535`);
        }
        redirectPort = p;
        break;
      }
      case '--credential':
        credential = true;
        break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }

  if (!outputFile) throw new Error('--output is required');

  const hasPublicClient = !!abapUrl || !!uaaUrl || !!clientId;
  const hasServiceKey = !!serviceKeyPath || !!envFilePath;

  if (hasPublicClient && hasServiceKey) {
    throw new Error(
      '--abap-url/--uaa-url/--client-id are mutually exclusive with --service-key/--env',
    );
  }

  if (hasPublicClient) {
    if (!abapUrl)
      throw new Error('--abap-url is required in public-client mode');
    if (!uaaUrl) throw new Error('--uaa-url is required in public-client mode');
    if (!clientId)
      throw new Error('--client-id is required in public-client mode');
    if (credential) {
      throw new Error('--credential is not supported in public-client mode');
    }
    if (format !== 'env') {
      throw new Error('--format json is not supported in public-client mode');
    }
    if (serviceUrl) {
      throw new Error(
        '--service-url is not supported in public-client mode; use --abap-url instead',
      );
    }
    return {
      mode: 'public-client',
      abapUrl,
      uaaUrl,
      clientId,
      outputFile,
      authType,
      browser,
      credential,
      format,
      serviceUrl,
      redirectPort,
    };
  }

  if (!serviceKeyPath && !envFilePath) {
    throw new Error(
      'Either --service-key or --env (or --abap-url) must be provided',
    );
  }
  return {
    mode: 'service-key',
    serviceKeyPath,
    envFilePath,
    outputFile,
    authType,
    browser,
    credential,
    format,
    serviceUrl,
    redirectPort,
  };
}
