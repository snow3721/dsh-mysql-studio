/**
 * dsh-mysql-studio — post-install verification.
 *
 * Run this after `scripts/install-profile.ps1`, before restarting `dsh web`. It
 * checks the two things a restart would otherwise be the first to discover:
 *
 *   1. the loader can resolve this plugin BY PACKAGE NAME from the profile, and
 *   2. the host half imports and registers its route from that resolved location
 *      (which is where mysql2 has to be findable too).
 *
 * It also serves one real request through the freshly registered route and
 * asserts the client bundle is present and well-formed. Nothing here needs a
 * database, and nothing writes outside the profile.
 *
 * Usage:
 *   node scripts/verify-install.mjs [profileName]
 */
import { createServer } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileName = process.argv[2] ?? 'web'
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profileName)
const manifestPath = join(profileDir, 'package.json')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log(`profile: ${profileDir}`)
console.log('')

// ── 1. the profile lists and links the package ──────────────────────────────

let manifest
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
} catch (error) {
  console.error(`cannot read ${manifestPath}: ${error.message}`)
  process.exit(1)
}

const spec = manifest.dependencies?.['dsh-mysql-studio']
check('profile declares the dependency', typeof spec === 'string', spec)

const bundles = manifest.dsh?.profile?.bundles ?? []
const layer = bundles.indexOf('dsh-mysql-studio')
check('profile lists the bundle layer', layer !== -1, `position ${layer} of ${bundles.length}`)

// This used to assert "applied last", which is where install-profile.ps1 appends
// it. That was really asserting the installer's behavior, not a requirement: a
// plugin the user installs LATER lands after this one and breaks the check while
// breaking nothing else. What actually matters is that the layers this one builds
// on are composed first, so those are the ones named here. Anything after is
// reported, not failed.
const PREREQUISITE_LAYERS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-better-sidebar']
const misordered = PREREQUISITE_LAYERS
  .filter(entry => bundles.includes(entry))
  .filter(entry => bundles.indexOf(entry) > layer)
check(
  'bundle layer is applied after the layers it builds on',
  layer !== -1 && misordered.length === 0,
  misordered.length === 0
    ? `after ${bundles.slice(0, layer).length} layer(s)${layer === bundles.length - 1 ? ', last' : `; later: ${bundles.slice(layer + 1).join(', ')}`}`
    : `these must come first: ${misordered.join(', ')}`,
)

// ── 2. the loader can resolve it by name, from the profile ──────────────────

const require = createRequire(manifestPath)
let entry
try {
  entry = require.resolve('dsh-mysql-studio')
  check('resolves by package name from the profile', true, entry)
} catch (error) {
  check('resolves by package name from the profile', false, error.message)
  process.exit(1)
}

// ── 3. the host half imports and registers its route there ──────────────────

let route
const opened = []
const registeredTools = []
const injectedServices = []

/** Stand-in tool registry, so the model-facing half is observable at mount. */
const toolsCtx = {
  tools: {
    register(definition) {
      registeredTools.push(definition)
      return () => {}
    },
  },
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
}

const ctx = {
  get: () => undefined,
  logger: { info: message => opened.push(message), warn: message => opened.push(message) },
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  // Cordis runs the callback once the named services are mounted. This script
  // DOES supply a tool registry, which is what makes the registrations below
  // checkable rather than assumed.
  inject(deps, fn) {
    injectedServices.push(deps)
    if (Array.isArray(deps) && deps.includes('tools')) fn(toolsCtx)
  },
  webServer: {
    register(definition) {
      route = definition
      return () => {}
    },
  },
}

let apply
let hostInject
try {
  const mod = await import(pathToFileURL(entry).href)
  apply = mod.apply
  hostInject = mod.inject
  check('host half imports from the installed path', typeof apply === 'function')
  check('host half declares its webServer dependency', Array.isArray(mod.inject) && mod.inject.includes('webServer'), JSON.stringify(mod.inject))
} catch (error) {
  check('host half imports from the installed path', false, error.message)
  process.exit(1)
}

try {
  apply(ctx, {})
  check('host half registers its route', route !== undefined && route.path === '/mysql-studio/api', route?.path)
} catch (error) {
  check('host half registers its route', false, error.message)
  process.exit(1)
}

// The model-facing half. `tools` is requested through ctx.inject rather than the
// plugin's own `inject` list, so the workbench survives a profile without
// dsh-tools — which also means a silently missing registration would never break
// the UI, and nothing but this check would notice.
check(
  'host half requests the tool registry optionally',
  injectedServices.some(deps => Array.isArray(deps) && deps.includes('tools'))
  && !(Array.isArray(hostInject) && hostInject.includes('tools')),
  JSON.stringify(injectedServices),
)
const toolNames = registeredTools.map(definition => definition.name)
check('host half registers its model tools', toolNames.length > 0, toolNames.join(', '))
check(
  'every registered tool carries the fields the registry projects',
  registeredTools.length > 0 && registeredTools.every(definition => typeof definition.name === 'string'
    && typeof definition.description === 'string' && definition.description !== ''
    && definition.parameters?.type === 'object'
    && typeof definition.output?.render === 'function'
    && typeof definition.output?.schema === 'object'
    && typeof definition.execute === 'function'),
)
// A write tool reachable by the model would be a policy change, not a feature;
// this asserts the read-only surface stayed read-only.
check(
  'no registered tool can write',
  registeredTools.every(definition => !/mutate|insert|update|delete|write/i.test(definition.name)),
  toolNames.join(', '),
)

// ── 4. the registered route actually answers ────────────────────────────────

const server = createServer((req, res) => { void route.handler(req, res) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(`${base}/mysql-studio/api/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const body = await response.json()
  check('health answers over HTTP', response.status === 200 && body.ok === true, JSON.stringify(body.result ?? body.error))
} finally {
  await new Promise(resolve => server.close(resolve))
}

// ── 5. the client half will compose ─────────────────────────────────────────
//
// The browser half is not discovered from the loader row directly: the host's
// `clientModules` service resolves the row's package manifest and reads
// `dsh.client` + `exports["./client"]`. Two of its failure modes are silent and
// one is fatal, so they are worth checking before a restart is the thing that
// finds them:
//
//   * `platform` that is not `"web"`  -> the row is skipped, no bundle, no UI.
//   * `dsh.client` with no `./client` export -> the composer THROWS at boot.
//   * the `./client` target missing on disk -> the served bundle 404s.

const pkgPath = join(profileDir, 'node_modules', 'dsh-mysql-studio', 'package.json')
const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
const clientDecl = pkg.dsh?.client

check('package declares dsh.client', clientDecl !== undefined && typeof clientDecl === 'object')
check('dsh.client.platform is "web"', clientDecl?.platform === 'web', String(clientDecl?.platform))

const clientExport = pkg.exports?.['./client']
const clientExportPath = typeof clientExport === 'string'
  ? clientExport
  : clientExport?.default
check('package exports a "./client" bundle', typeof clientExportPath === 'string', String(clientExportPath))

let clientBundleExists = false
if (typeof clientExportPath === 'string') {
  const clientPath = join(profileDir, 'node_modules', 'dsh-mysql-studio', clientExportPath)
  try {
    await access(clientPath)
    clientBundleExists = true
    const source = await readFile(clientPath, 'utf8')
    check('client bundle exists', true, clientPath)
    check('client bundle uses the module-loader wrapper', /window\.__ModuleLoader__\.load\(\{/.test(source))
    check('client bundle declares the package name as its id', /id:\s*"dsh-mysql-studio"/.test(source))
  } catch (error) {
    check('client bundle exists', false, error.message)
  }
}

// `options.external` is the one array the composer validates destructively: an
// entry naming the package itself throws, and a missing supplier breaks boot.
const external = clientDecl?.external
if (external === undefined) {
  check('dsh.client.external is absent (baseline modules only)', true)
} else {
  const list = Array.isArray(external) ? external : null
  check('dsh.client.external is a string array', list !== null && list.every(entry => typeof entry === 'string'))
  check('dsh.client.external does not name this package', list === null || !list.includes('dsh-mysql-studio'))
}
const injectList = clientDecl?.inject
check('dsh.client.inject is a string array', injectList === undefined
  || (Array.isArray(injectList) && injectList.every(entry => typeof entry === 'string')),
  JSON.stringify(injectList))

// If the real composer is reachable, let IT order a graph containing this row —
// that is the only way to know the row survives the graph validator rather than
// merely looking valid to this script.
const clientModulesPath = process.env.DSH_CLIENT_MODULES
  ?? process.env.NODE_PATH?.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).map(base => join(base, '@deepseek-ai', 'dsh-client-modules'))[0]
if (clientModulesPath === undefined) {
  console.log('  --   skipped the real graph validator (set DSH_CLIENT_MODULES to its package path to run it)')
} else {
  try {
    const composer = await import(pathToFileURL(join(clientModulesPath, 'lib', 'index.js')).href)
    const row = {
      id: 'dsh-mysql-studio',
      inject: injectList,
      external: external ?? [],
      immediately: true,
    }
    const ordered = composer.orderByModuleGraph([{ id: '@deepseek-ai/dsh-client-modules' }, row])
    check('the real graph validator accepts this row', ordered.some(entry => entry.id === 'dsh-mysql-studio'))
    const injections = composer.bootInjections({ entries: [row], batches: [{ phase: 'application', url: '/plugins/dsh-mysql-studio/client.js' }] })
    const carriesBundle = injections.some(entry => typeof entry.src === 'string' && entry.src.includes('dsh-mysql-studio'))
    check('bootInjections would ship this bundle to the page', carriesBundle)
  } catch (error) {
    check('the real graph validator accepts this row', false, error.message.split('\n')[0])
  }
}

// ── 6. the plugin carries its own drivers ───────────────────────────────────
//
// This was once a soft check, justified by a fallback that read mysql2 out of the
// hosting profile. That was a mistake worth recording: the profile's mysql2 had
// arrived as a dependency of ANOTHER plugin (dsh-sql), so when that plugin was
// reinstalled away, mysql2 vanished. This plugin kept working only because the
// running process had already cached the module, and it would have failed on the
// next boot. A plugin that needs a driver carries it.

try {
  const mysql = createRequire(entry)('mysql2/promise')
  const version = JSON.parse(await readFile(createRequire(entry).resolve('mysql2/package.json'), 'utf8')).version
  check('the plugin carries its own mysql2', typeof mysql.createPool === 'function', `mysql2 ${version}`)
} catch (error) {
  check('the plugin carries its own mysql2', false,
    `run \`pnpm install\` in the plugin directory — ${String(error.message).split('\n')[0]}`)
}

try {
  const dbModule = await import(pathToFileURL(join(entry, '..', 'db.js')).href)
  const mysql = dbModule.loadMysql()
  check('the resolver used at runtime finds mysql2', typeof mysql.createPool === 'function')
} catch (error) {
  check('the resolver used at runtime finds mysql2', false, error.message.split('\n')[0])
}

console.log('')
const failed = results.filter(entry => !entry.ok)
if (failed.length === 0) {
  // Deliberately not "restart dsh web": this script checks the INSTALL, and the
  // install is sound whether or not anything is pending. A restart is only needed
  // after host-half code changes — and `verify-live.mjs` is what tells you whether
  // the running process actually picked them up, rather than assuming it did.
  console.log('All checks passed. The install is sound.')
  console.log('After changing host-half code: restart `dsh web`, then run `node scripts/verify-live.mjs`.')
  console.log('After changing client-half code: hard-refresh the browser (Ctrl+Shift+R).')
} else {
  console.log(`${failed.length} check(s) failed:`)
  for (const entry of failed) console.log(`  - ${entry.label}: ${entry.detail ?? ''}`)
  process.exitCode = 1
}
