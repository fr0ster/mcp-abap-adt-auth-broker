// The bin smoke check (spec §10): what a user installs from npm, not what the
// workspace links.
//
// Packs every workspace, installs the tarballs into an empty project outside
// the repository, and checks there that
//   - each tarball ships its `dist` and names no sibling by path;
//   - the library has no `bin` and does not depend on auth-stores (H0) — the
//     commands are the CLI's;
//   - the CLI resolves the PACKED library, not a copy of its own from the
//     registry;
//   - every bin the CLI declares starts: `--version` exits 0 and prints the
//     CLI's own version (not the library's), `help` exits 0 and prints usage;
//   - `require('@mcp-abap-adt/auth-broker')` loads and exports `AuthBroker`.
//
// It exists because 3.0.3 shipped a bin that died on MODULE_NOT_FOUND: the
// bins `require`d the library by a path into `dist`, which held only while
// both lived in one package. A workspace link hides that; a packed install
// does not.
//
// Installing the tarballs pulls their other dependencies from the registry, so
// this needs the network, and says so when it cannot reach it.
//
//   npm run build && node tools/check-packed.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LIBRARY = '@mcp-abap-adt/auth-broker';
const CLI = '@mcp-abap-adt/auth-broker-cli';

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// A failed command's stderr is a stack trace; the line naming the error is the
// one worth reading.
const firstError = (text) => {
  const lines = (text ?? '').split('\n').map((l) => l.trim());
  return lines.find((l) => /Error\b/.test(l)) ?? lines.find(Boolean) ?? '';
};

const problems = [];
const workspaces = readJson(path.join(ROOT, 'package.json')).workspaces;
const manifests = Object.fromEntries(
  workspaces.map((ws) => {
    const manifest = readJson(path.join(ROOT, ws, 'package.json'));
    return [manifest.name, { dir: path.join(ROOT, ws), manifest }];
  }),
);
for (const name of [LIBRARY, CLI])
  if (!manifests[name]) problems.push(`${name}: not a workspace`);

let work;
let files = [];
let bins = [];

try {
  if (problems.length) throw new Error('workspaces missing');

  // 1. Pack. `npm pack` does not build: a missing dist is reported as such.
  for (const { dir, manifest } of Object.values(manifests))
    if (!fs.existsSync(path.join(dir, 'dist')))
      throw new Error(
        `${manifest.name}: no dist/ — run npm run build before this check`,
      );
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-broker-packed-'));
  const tarballs = path.join(work, 'tarballs');
  fs.mkdirSync(tarballs);
  for (const { dir } of Object.values(manifests))
    run('npm', ['pack', '--pack-destination', tarballs, '--silent'], dir);
  files = fs.readdirSync(tarballs).map((f) => path.join(tarballs, f));

  // 2. The tarballs themselves.
  for (const tgz of files) {
    const listing = run('tar', ['-tzf', tgz], work).split('\n');
    const manifest = JSON.parse(
      run('tar', ['-xzOf', tgz, 'package/package.json'], work),
    );
    const label = `${manifest.name}@${manifest.version}`;
    if (!listing.some((f) => f.startsWith('package/dist/')))
      problems.push(`${label}: ships no dist/`);
    if (listing.some((f) => f.includes('/__tests__/')))
      problems.push(`${label}: ships its tests`);
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {}))
      if (/^(workspace:|file:|link:|\.)/.test(range))
        problems.push(`${label}: ${dep} is "${range}", not a published range`);

    if (manifest.name === LIBRARY) {
      if (manifest.bin !== undefined)
        problems.push(
          `${label}: declares bin ${JSON.stringify(manifest.bin)}; the commands are ${CLI}'s`,
        );
      if ('@mcp-abap-adt/auth-stores' in (manifest.dependencies ?? {}))
        problems.push(
          `${label}: depends on @mcp-abap-adt/auth-stores; the library speaks only the store contracts (H0)`,
        );
      for (const f of ['package/dist/index.js', 'package/dist/index.d.ts'])
        if (!listing.includes(f)) problems.push(`${label}: no ${f.slice(8)}`);
    }

    if (manifest.name === CLI) {
      bins = Object.entries(manifest.bin ?? {});
      if (bins.length === 0) problems.push(`${label}: declares no bin`);
      for (const [bin, target] of bins) {
        const file = `package/${path.posix.normalize(target)}`;
        if (!listing.includes(file))
          problems.push(
            `${label}: bin ${bin} points at ${target}, not shipped`,
          );
      }
      if (!(LIBRARY in (manifest.dependencies ?? {})))
        problems.push(`${label}: does not depend on ${LIBRARY}`);
    }
  }

  if (!problems.length) {
    // 3. Install into an empty project: no workspace links, no repository
    // .npmrc, nothing but the tarballs and the registry.
    const consumer = path.join(work, 'consumer');
    fs.mkdirSync(consumer);
    run('npm', ['init', '-y'], consumer);
    const install = spawnSync(
      'npm',
      [
        'install',
        '--no-save',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...files,
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    if (install.status !== 0) {
      const output = `${install.stdout ?? ''}${install.stderr ?? ''}`;
      const offline =
        /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|network/i.test(
          output,
        );
      throw new Error(
        offline
          ? 'this check needs the network: installing the tarballs pulls their ' +
              'dependencies from the registry, and the registry could not be ' +
              `reached.\n${output.trim()}`
          : `npm install of the tarballs failed:\n${output.trim()}`,
      );
    }

    const scope = path.join(consumer, 'node_modules', '@mcp-abap-adt');
    for (const name of [LIBRARY, CLI]) {
      const installed = path.join(scope, name.split('/')[1]);
      if (!fs.existsSync(installed)) problems.push(`${name}: not installed`);
      else if (fs.lstatSync(installed).isSymbolicLink())
        problems.push(`${name}: a symlink, not an installed copy`);
    }
    // A nested copy means the CLI's range did not accept the packed library,
    // and it would run against whatever the registry serves instead.
    const nested = path.join(
      scope,
      'auth-broker-cli',
      'node_modules',
      '@mcp-abap-adt',
      'auth-broker',
    );
    if (fs.existsSync(nested))
      problems.push(
        `${CLI} carries its own ${LIBRARY} ${readJson(path.join(nested, 'package.json')).version}, not the packed one`,
      );

    // 4. Every bin starts. Through node_modules/.bin, as a user's shell would.
    const cliVersion = manifests[CLI].manifest.version;
    const libraryVersion = manifests[LIBRARY].manifest.version;
    for (const [bin] of bins) {
      const exe = path.join(consumer, 'node_modules', '.bin', bin);
      const call = (args) =>
        spawnSync(exe, args, {
          cwd: consumer,
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

      const version = call(['--version']);
      const printed = (version.stdout ?? '').trim();
      if (version.status !== 0)
        problems.push(
          `${bin} --version: exit ${version.status ?? version.signal}: ${firstError(version.stderr || version.error?.message)}`,
        );
      else if (printed !== cliVersion)
        problems.push(
          `${bin} --version printed "${printed}", not ${CLI}'s ${cliVersion}` +
            (printed === libraryVersion ? ` (that is ${LIBRARY}'s)` : ''),
        );
      else console.log(`${bin} --version: ${printed}`);

      const help = call(['help']);
      if (help.status !== 0)
        problems.push(
          `${bin} help: exit ${help.status ?? help.signal}: ${firstError(help.stderr || help.error?.message)}`,
        );
      else if (!/usage/i.test(help.stdout ?? ''))
        problems.push(`${bin} help: printed no usage`);
      else console.log(`${bin} help: ${help.stdout.split('\n')[0]}`);
    }

    // 5. The library loads on its own.
    const load = spawnSync(
      process.execPath,
      [
        '-e',
        `const m = require(${JSON.stringify(LIBRARY)}); if (typeof m.AuthBroker !== 'function') { console.error('no AuthBroker export'); process.exit(1); }`,
      ],
      { cwd: consumer, encoding: 'utf8' },
    );
    if (load.status !== 0)
      problems.push(`require('${LIBRARY}'): ${firstError(load.stderr)}`);
  }
} catch (error) {
  problems.push(String(error?.message ?? error));
} finally {
  if (work) fs.rmSync(work, { recursive: true, force: true });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log(
  `packed: ${files.length} tarballs install cleanly, ${bins.map(([b]) => b).join(' and ')} start and report ${CLI}'s version, and ${LIBRARY} loads without a bin`,
);
