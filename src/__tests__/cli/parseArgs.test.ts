// src/__tests__/cli/parseArgs.test.ts
import { parseArgs } from '../../cli/parseArgs';

describe('parseArgs — public-client mode', () => {
  it('parses --abap-url --uaa-url --client-id --output', () => {
    const opts = parseArgs([
      '--abap-url',
      'https://abap.example/',
      '--uaa-url',
      'https://uaa.example',
      '--client-id',
      'cid',
      '--output',
      '/tmp/out.env',
    ]);
    expect(opts.mode).toBe('public-client');
    expect(opts.abapUrl).toBe('https://abap.example/');
    expect(opts.uaaUrl).toBe('https://uaa.example');
    expect(opts.clientId).toBe('cid');
    expect(opts.outputFile).toBe('/tmp/out.env');
  });

  it('rejects --abap-url combined with --service-key', () => {
    expect(() =>
      parseArgs([
        '--abap-url',
        'x',
        '--uaa-url',
        'y',
        '--client-id',
        'z',
        '--service-key',
        'k.json',
        '--output',
        'o.env',
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it('requires --uaa-url and --client-id when --abap-url is given', () => {
    expect(() => parseArgs(['--abap-url', 'x', '--output', 'o.env'])).toThrow(
      /--uaa-url/,
    );
    expect(() =>
      parseArgs(['--abap-url', 'x', '--uaa-url', 'y', '--output', 'o.env']),
    ).toThrow(/--client-id/);
  });

  it('still parses legacy --service-key mode', () => {
    const opts = parseArgs([
      '--service-key',
      'key.json',
      '--output',
      'o.env',
      '--type',
      'xsuaa',
    ]);
    expect(opts.mode).toBe('service-key');
    expect(opts.serviceKeyPath).toBe('key.json');
    expect(opts.authType).toBe('xsuaa');
  });

  it('rejects unsupported flags in public-client mode', () => {
    expect(() =>
      parseArgs([
        '--abap-url',
        'x',
        '--uaa-url',
        'y',
        '--client-id',
        'z',
        '--credential',
        '--output',
        'o.env',
      ]),
    ).toThrow(/--credential/);

    expect(() =>
      parseArgs([
        '--abap-url',
        'x',
        '--uaa-url',
        'y',
        '--client-id',
        'z',
        '--format',
        'json',
        '--output',
        'o.env',
      ]),
    ).toThrow(/--format json/);

    expect(() =>
      parseArgs([
        '--abap-url',
        'x',
        '--uaa-url',
        'y',
        '--client-id',
        'z',
        '--service-url',
        'https://ignored.example',
        '--output',
        'o.env',
      ]),
    ).toThrow(/--service-url/);
  });
});
