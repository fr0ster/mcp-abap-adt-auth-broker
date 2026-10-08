// Every package imports only what its allowlist below permits, declares it in package.json,
// imports everything it declares, and never reaches outside its own src with a
// relative path.
//   node tools/check-graph.js
//
// **Adapted from mcp-abap-adt-interfaces, not copied**.
// There `src` holds no tests, so every file is runtime code and every import is
// compared with `dependencies`. Here `src/__tests__` imports what only the
// tests need (auth-stores, auth-providers, the logger, js-yaml), declared as
// dev dependencies. So the rules split:
//
//   - runtime files (everything under src/ outside __tests__): each import is
//     on the package's allowlist and in `dependencies`, and every dependency
//     is imported by at least one of them;
//   - test files (under __tests__): each import is declared, in
//     `devDependencies` or `dependencies`; nothing undeclared.
//
// "The library speaks only the store contracts, never a storage" — it never
// imports auth-stores — is the allowlist below: the
// library's runtime may not import it, and may not depend on it.
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const ROOT = path.resolve(__dirname, '..');

const ALLOWED = {
  'auth-broker': [
    '@mcp-abap-adt/interfaces-auth',
    '@mcp-abap-adt/interfaces-auth-sap',
    '@mcp-abap-adt/interfaces-auth-broker',
    '@mcp-abap-adt/interfaces-utils',
    '@mcp-abap-adt/auth-providers',
    '@mcp-abap-adt/auth-errors',
  ],
  'auth-broker-cli': [
    '@mcp-abap-adt/auth-broker',
    '@mcp-abap-adt/auth-stores',
    '@mcp-abap-adt/auth-providers',
    '@mcp-abap-adt/auth-errors',
    '@mcp-abap-adt/interfaces-auth',
    '@mcp-abap-adt/interfaces-auth-sap',
    '@mcp-abap-adt/interfaces-auth-broker',
    '@mcp-abap-adt/interfaces-utils',
    '@mcp-abap-adt/logger',
  ],
};

const BUILTINS = new Set(builtinModules);
const isBuiltin = (spec) =>
  spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0]);

/** `@scope/name/sub/path` -> `@scope/name`; `name/sub` -> `name`. */
const packageOf = (spec) =>
  spec
    .split('/')
    .slice(0, spec.startsWith('@') ? 2 : 1)
    .join('/');

function tsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(f) : f.endsWith('.ts') ? [f] : [];
  });
}

/** Every module specifier a file names: import/export from, import(), require(). */
function specifiers(text) {
  const out = [];
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
  for (const m of text.matchAll(pattern)) out.push(m[1]);
  return out;
}

const problems = [];
const packagesDir = path.join(ROOT, 'packages');
for (const dir of fs.readdirSync(packagesDir)) {
  if (!fs.existsSync(path.join(packagesDir, dir, 'package.json'))) continue;
  if (!(dir in ALLOWED)) {
    problems.push(`${dir}: not a package this repository defines`);
    continue;
  }
  const pkgRoot = path.join(packagesDir, dir);
  const src = path.join(pkgRoot, 'src');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'),
  );
  const runtimeDeps = Object.keys(manifest.dependencies ?? {});
  const devDeps = Object.keys(manifest.devDependencies ?? {});

  for (const dep of runtimeDeps)
    if (!ALLOWED[dir].includes(dep))
      problems.push(`${dir}: package.json depends on ${dep}, not allowed`);

  const imported = new Set();
  for (const file of tsFiles(src)) {
    const rel = path.relative(ROOT, file);
    const isTest = path
      .relative(src, file)
      .split(path.sep)
      .includes('__tests__');
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec);
        if (!target.startsWith(src + path.sep))
          problems.push(`${rel}: relative import leaves the package: ${spec}`);
        continue;
      }
      if (isBuiltin(spec)) continue;
      const name = packageOf(spec);
      if (isTest) {
        if (!runtimeDeps.includes(name) && !devDeps.includes(name))
          problems.push(
            `${rel}: imports ${spec}, declared in neither dependencies nor devDependencies`,
          );
        continue;
      }
      if (!ALLOWED[dir].includes(name))
        problems.push(`${rel}: imports ${spec}, not allowed for ${dir}`);
      else if (!runtimeDeps.includes(name))
        problems.push(
          `${rel}: imports ${spec}, missing from dependencies` +
            (devDeps.includes(name) ? ' (it is only a dev dependency)' : ''),
        );
      else imported.add(name);
    }
  }

  // A dependency no runtime file imports is an edge every consumer installs
  // and nothing uses. What only the tests import belongs in devDependencies.
  for (const dep of runtimeDeps)
    if (!imported.has(dep))
      problems.push(
        `${dir}: package.json depends on ${dep}, which no runtime file in src imports`,
      );

  // The project references have to agree with the imports, or a build edge
  // outlives the import that justified it.
  for (const name of ['tsconfig.json', 'tsconfig.build.json']) {
    const file = path.join(pkgRoot, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/"path"\s*:\s*"\.\.\/([^/"]+)/g)) {
      const dep = `@mcp-abap-adt/${m[1]}`;
      if (!imported.has(dep))
        problems.push(
          `${dir}/${name}: references ${m[1]}, which no runtime file in src imports`,
        );
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('graph: every import is allowed and declared');
