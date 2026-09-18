/**
 * dsh-mysql-studio — live deployment verification.
 *
 * Everything in `test/` exercises the plugin's code in-process. This script talks
 * to the plugin running INSIDE a real `dsh web`, over the same HTTP surface the
 * browser half uses, against a real MySQL server — so it proves the DEPLOYMENT
 * rather than the source:
 *
 *   * the host half mounted and registered its route;
 *   * mysql2 resolves from wherever the loader actually put the plugin;
 *   * profiles round-trip through the real store document;
 *   * reads, a dry run, a committed write, a real conflict, and a refused
 *     write all behave over the wire.
 *
 * A direct mysql2 connection is used for two things only — creating/dropping the
 * scratch table, and moving a row behind the plugin's back to force a genuine
 * conflict. Every read and every mutation goes through the live route.
 *
 * The run removes the profile it saved and drops the table it created, so it
 * leaves the store and the target server as it found them.
 *
 * Usage:
 *   node scripts/verify-live.mjs [baseUrl] [mysqlUrl]
 */
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { parseConnectionUrl } from '../lib/store.js'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
const MYSQL_URL = process.argv[3] ?? 'mysql://root:root@192.168.100.128:3307'
const PROBE = '__dsh_mysql_studio_probe'

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** One API call, exactly as the browser half makes it. */
async function call(method, params) {
  const response = await fetch(`${BASE}/mysql-studio/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

const credentials = parseConnectionUrl(MYSQL_URL)
console.log(`base:  ${BASE}`)
console.log(`mysql: ${credentials.user}@${credentials.host}:${credentials.port}`)
console.log('')

// ── the host half is mounted ────────────────────────────────────────────────

const health = await call('health')
if (health.status !== 200 || health.body?.ok !== true) {
  console.error(`the plugin is not answering at ${BASE}/mysql-studio/api — has dsh web been restarted?`)
  console.error(JSON.stringify(health.body))
  process.exit(1)
}
check('the host half is mounted and answers', true, health.body.result.plugin)
check('it reports its real store path', /mysql-studio[\\/]connections\.json$/.test(health.body.result.storePath), health.body.result.storePath)

// The agent surface, asked of the RUNNING process rather than the source.
//
// `tools` is an optional dependency, so a deployment where the registry never
// mounted serves a perfectly healthy sidebar and no tools at all. That failure
// mode is silent by construction, which is exactly why it is checked here: if
// this line fails while the source registers three tools, the answer is either a
// stale process or a profile composed without a tool registry.
const modelTools = health.body.result.modelTools
const deployedTools = Array.isArray(modelTools?.tools) ? modelTools.tools : undefined
check(
  'the deployed plugin registered its model tools',
  modelTools?.registryMounted === true && deployedTools !== undefined && deployedTools.length > 0,
  modelTools === undefined
    ? 'this process predates the model tools — restart dsh web'
    : deployedTools === undefined
      ? 'this process predates the per-tool parameter report — restart dsh web'
      : `${modelTools.registryMounted ? 'registry mounted' : 'NO tool registry in this profile'}: ${deployedTools.map(tool => tool.name).join(', ')}`,
)
// Only meaningful once tools are actually registered. Asserting either of these
// against an empty list would be vacuously green — the failure mode this file
// exists to avoid — so they are skipped loudly instead.
if (deployedTools !== undefined && deployedTools.length > 0) {
  check(
    'no deployed tool can write',
    !deployedTools.some(tool => /mutate|insert|update|delete|write/i.test(tool.name)),
    deployedTools.map(tool => tool.name).join(', '),
  )
  // A list of tool NAMES cannot tell one generation of this surface from the
  // next; the parameter the newest generation added can. This is the cheapest
  // honest answer to "did my restart actually land".
  const query = deployedTools.find(tool => tool.name === 'mysql_query')
  check(
    'the deployed mysql_query is a one-shot read, not a cursor',
    Array.isArray(query?.parameters)
      && query.parameters.includes('sql')
      && !query.parameters.includes('cursor'),
    query === undefined ? 'mysql_query is not registered' : `parameters: ${(query.parameters ?? []).join(', ')}`,
  )
} else {
  console.log('  --   skipped the deployed tool-surface checks (no tools registered to inspect)')
}

// Only POST is served; the route says so with its own envelope rather than the
// host's bare 405, which is how a mounted plugin is distinguishable at all.
const rawGet = await new Promise((resolve, reject) => {
  const req = httpRequest(
    { host: '127.0.0.1', port: Number(new URL(BASE).port || 3080), path: '/mysql-studio/api/health', method: 'GET' },
    res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], text }))
    },
  )
  req.on('error', reject)
  req.end()
})
check('a non-POST request is refused by the plugin itself', rawGet.status === 405 && /method-not-allowed/.test(rawGet.text),
  `${rawGet.status} ${rawGet.type ?? '(no content-type)'} ${rawGet.text.slice(0, 80)}`)

// ── scaffolding (direct, not through the plugin) ────────────────────────────

const require = createRequire(import.meta.url)
let mysql
for (const anchor of [import.meta.url, 'file:///C:/Users/YSH/.dsh/profiles/web/package.json']) {
  try {
    mysql = createRequire(anchor)('mysql2/promise')
    break
  } catch { /* try the next anchor */ }
}
if (mysql === undefined) {
  console.error('could not load mysql2 for the scaffolding connection')
  process.exit(1)
}

const saved = await call('conn.save', { draft: { name: 'verify-live', connectTimeoutMs: 8000, ...credentials } })
if (saved.status !== 200) {
  console.error(`could not save a connection: ${JSON.stringify(saved.body)}`)
  process.exit(1)
}
const id = saved.body.result.connection.id
const connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password, connectTimeout: 8000 })

let database
try {
  const [schemas] = await connection.query(
    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql','information_schema','performance_schema','sys') ORDER BY SCHEMA_NAME",
  )
  const names = schemas.map(row => row.SCHEMA_NAME)
  database = names.includes('case_test') ? 'case_test' : names[0]
  await connection.query(`DROP TABLE IF EXISTS \`${database}\`.\`${PROBE}\``)
  await connection.query(
    `CREATE TABLE \`${database}\`.\`${PROBE}\` (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32) NOT NULL, qty INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  await connection.query(`INSERT INTO \`${database}\`.\`${PROBE}\` (id, name, qty) VALUES (1, 'alpha', 1), (2, 'beta', 2)`)

  // ── through the live route from here on ──────────────────────────────────

  const probe = await call('conn.test', { id })
  check('the live process reaches MySQL', probe.body?.result?.ok === true,
    `MySQL ${probe.body?.result?.version} in ${probe.body?.result?.latencyMs}ms`)

  // A profile left over from the removed Socket transport has no `host` key.
  // mysql2 reads a missing host as `localhost`, so the plugin has to refuse it
  // before the driver sees it — and name the transport that went away, rather
  // than just demanding a host (which reads as "you forgot to fill this in").
  // `draft` is never written to the store, so this probes the path, not the file.
  const legacySocket = await call('conn.test', {
    draft: { name: 'legacy-socket', user: 'root', password: 'x', socketPath: '/var/run/mysqld/mysqld.sock' },
  })
  check('a leftover Socket profile names the removed transport',
    legacySocket.status === 400
      && legacySocket.body.error.code === 'request-failed'
      && /Socket/.test(legacySocket.body.error.message),
    legacySocket.body.error?.message?.slice(0, 72))

  const databases = await call('catalog.databases', { id })
  const userDatabases = databases.body.result.databases.filter(entry => !entry.system)
  check('the catalog lists schemas', userDatabases.length > 0,
    `${databases.body.result.databases.length} total, ${userDatabases.length} non-system`)

  const tables = await call('catalog.tables', { id, database })
  check('the catalog lists relations', tables.body.result.tables.length > 0, `${database}: ${tables.body.result.tables.length}`)

  const populated = tables.body.result.tables
    .filter(entry => entry.type === 'BASE TABLE' && (entry.estimatedRows ?? 0) > 1)
    .sort((a, b) => (b.estimatedRows ?? 0) - (a.estimatedRows ?? 0))[0]
  if (populated !== undefined) {
    const first = await call('data.rows', { id, database, table: populated.name, limit: 3, offset: 0 })
    const second = await call('data.rows', { id, database, table: populated.name, limit: 3, offset: 1 })
    // Compare the WHOLE row, not its first cell: a composite key legitimately
    // repeats its leading column across rows, so `[0]` alone proves nothing.
    const rowKey = page => JSON.stringify(page.body.result.rows[0])
    check('paging advances through a real table',
      first.body.result.rows.length > 0 && rowKey(second) !== rowKey(first),
      `${database}.${populated.name} pk=(${first.body.result.primaryKey.join(',')}) ${rowKey(first)} -> ${rowKey(second)}`)
  }

  const literal = await call('query.run', { id, database, sql: "SELECT 'kept' AS s, 7 AS n", limit: 5 })
  check('a read-only statement keeps its literals', literal.body.result?.rows?.[0]?.[0] === 'kept', JSON.stringify(literal.body.result?.rows?.[0]))
  const refused = await call('query.run', { id, database, sql: 'DROP TABLE nope' })
  check('the read-only guard refuses a write', refused.status === 400 && /只读/.test(refused.body.error.message))

  // ── the scratch table: dry run, commit, conflict, delete ────────────────

  const scope = { id, database, table: PROBE }
  const readBack = async () => {
    const [rows] = await connection.query(`SELECT id, name, qty FROM \`${database}\`.\`${PROBE}\` ORDER BY id`)
    return rows.map(row => `${row.id}:${row.name}:${row.qty}`)
  }

  // A write hidden behind a reading verb. `WITH … DELETE` is valid MySQL 8 and
  // starts with WITH, so a prefix check sees a read — and this one really did
  // delete a row before the guard learned to look past the CTE list.
  //
  // It targets the SCRATCH table on purpose. Pointed at a table MySQL itself
  // refuses to modify, the server's own denial would mask whether the guard
  // refused, and the check would pass while measuring nothing. Here the guard is
  // the only thing that can stop it — and `WHERE 1 = 0` means that if the guard
  // does let it through, the run still destroys nothing.
  const cteWrite = await call('query.run', {
    id,
    database,
    sql: `WITH cte AS (SELECT 1 AS x) DELETE FROM \`${PROBE}\` WHERE 1 = 0`,
  })
  check('the read-only guard refuses a data-modifying CTE',
    cteWrite.status === 400 && /data-modifying CTE|WITH 之后/.test(cteWrite.body.error.message),
    cteWrite.status === 400
      ? String(cteWrite.body.error.message).slice(0, 60)
      : `NOT REFUSED — the write reached MySQL (status ${cteWrite.status})`)

  const execWrite = await call('query.exec', {
    id,
    database,
    sql: `INSERT INTO \`${PROBE}\` (name, qty) VALUES ('nope', 0)`,
  })
  check('query.exec previews a write and does not execute it',
    execWrite.body.result?.needsConfirm === true && (await readBack())[0] === '1:alpha:1',
    execWrite.body.result?.sql?.slice(0, 80))

  const createPreview = await call('schema.createDatabase', {
    id, name: '__dsh_ms_verify_never', charset: 'utf8mb4', dryRun: true,
  })
  check('schema.createDatabase dry-runs CREATE DATABASE',
    createPreview.body.result?.needsConfirm === true
      && /CREATE DATABASE `__dsh_ms_verify_never`/.test(createPreview.body.result.sql),
    createPreview.body.result?.sql)

  const dry = await call('data.mutate', {
    ...scope, concurrency: 'pk-changed', dryRun: true,
    mutations: [{ kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha', qty: 1 } }],
  })
  check('a dry run plans the statement and writes nothing',
    dry.body.result.dryRun === true && /SET `name` = 'ALPHA'/.test(dry.body.result.statements[0]) && (await readBack())[0] === '1:alpha:1',
    dry.body.result.statements[0])

  // 0.6.0 removed the `pk-row` concurrency mode. A client bundle and a host half
  // can be restarted independently, so a stale client will keep sending it: the
  // contract is that it degrades to the default rather than erroring. `pk-row`
  // identified by every column, `pk-changed` by the key plus the changed ones —
  // so the absence of `qty` in the WHERE clause is what proves the mode is gone.
  const legacyRow = await call('data.mutate', {
    ...scope, concurrency: 'pk-row', dryRun: true,
    mutations: [{ kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha', qty: 1 } }],
  })
  check('the removed pk-row mode degrades to pk-changed instead of failing',
    legacyRow.status === 200
      && legacyRow.body.result.dryRun === true
      && /WHERE `id` <=> \? AND `name` <=> \?$/.test(legacyRow.body.result.statements[0]),
    legacyRow.body.result?.statements?.[0] ?? legacyRow.body.error?.message)

  const committed = await call('data.mutate', {
    ...scope, concurrency: 'pk-changed',
    mutations: [
      { kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha', qty: 1 } },
      { kind: 'insert', values: { name: 'gamma', qty: 3 } },
      { kind: 'delete', key: { id: 2 }, original: { id: 2, name: 'beta' } },
    ],
  })
  check('a three-way batch commits', committed.body.result.committed === true && committed.body.result.statements.length === 3,
    (await readBack()).join(' | '))

  // Move a row behind the plugin's back, then commit a batch whose FIRST
  // mutation is valid and whose SECOND is stale. The whole batch must vanish.
  const insertedId = committed.body.result.results.find(entry => entry.kind === 'insert')?.insertId
  await connection.query(`UPDATE \`${database}\`.\`${PROBE}\` SET name = 'moved' WHERE id = 1`)
  const before = await readBack()
  const conflict = await call('data.mutate', {
    ...scope, concurrency: 'pk-changed',
    mutations: [
      { kind: 'update', key: { id: 1 }, set: { name: 'FIRST' }, original: { id: 1, name: 'ALPHA', qty: 1 } },
      { kind: 'update', key: { id: insertedId }, set: { name: 'GAMMA' }, original: { id: insertedId, name: 'gamma', qty: 3 } },
    ],
  })
  check('a stale original is refused as a conflict', conflict.status === 400 && conflict.body.error.code === 'conflict',
    conflict.body.error?.message?.slice(0, 40))
  const after = await readBack()
  // Byte-identical before and after is the strongest statement of atomicity: the
  // first, valid mutation left nothing behind.
  check('the failed batch left the table byte-identical', after.join('|') === before.join('|'), `${before.join(' | ')}  ==  ${after.join(' | ')}`)

  check('the profile never handed its password to the renderer',
    saved.body.result.connection.password === undefined && saved.body.result.connection.hasPassword === true)
} finally {
  await connection.query(`DROP TABLE IF EXISTS \`${database ?? 'case_test'}\`.\`${PROBE}\``).catch(() => {})
  await connection.end().catch(() => {})
  const removed = await call('conn.delete', { id })
  check('the verification profile is removed again', removed.body?.result?.ok === true)
}

console.log('')
const failed = results.filter(entry => !entry.ok)
console.log(failed.length === 0
  ? `All ${results.length} live checks passed against the plugin running inside dsh web.`
  : `${failed.length} of ${results.length} live checks failed: ${failed.map(entry => entry.label).join(', ')}`)
process.exitCode = failed.length === 0 ? 0 : 1
