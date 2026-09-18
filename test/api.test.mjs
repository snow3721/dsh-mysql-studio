/**
 * dsh-mysql-studio — end-to-end API tests.
 *
 * The host half's real product is one HTTP route. These tests mount the actual
 * plugin against a stand-in Cordis context, capture the route it registers, and
 * serve it from a real loopback HTTP server — then drive it with real `fetch`
 * calls, exactly as the browser half does.
 *
 * What this covers that the module tests cannot: the trust fence, method
 * dispatch, JSON body handling, the response envelope, and the fact that a
 * connection saved through the API is the one later queried through it.
 *
 * The live half is skipped (not failed) when the MySQL instance is unreachable.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { request as httpRequest } from 'node:http'

const scratch = await mkdtemp(join(tmpdir(), 'mysql-studio-api-'))
process.env.DSH_HOME = scratch

const { apply } = await import('../lib/index.js')
const { storePath: storePathFromLib } = await import('../lib/store.js')
const { normalizeProfile, parseConnectionUrl } = await import('../lib/store.js')
const { listDatabases, PoolRegistry } = await import('../lib/db.js')

const LIVE_URL = process.env.DSH_MYSQL_STUDIO_TEST_URL ?? 'mysql://root:root@192.168.100.128:3307'

/** Mount the plugin and serve its route on an ephemeral loopback port. */
async function mount() {
  let route
  const ctx = {
    effects: [],
    injected: [],
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
    // Cordis calls the callback only once every named service is mounted. Nothing
    // here mounts `tools`, so recording the request without invoking it is the
    // faithful stand-in for a profile composed without dsh-tools — and it is what
    // makes this mount a test that the HTTP half does not depend on the registry.
    inject(deps) {
      this.injected.push(deps)
    },
    effect(fn) {
      const dispose = fn()
      this.effects.push(dispose)
      return () => {}
    },
    webServer: {
      register(definition) {
        route = definition
        return () => {}
      },
    },
  }
  apply(ctx, {})
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/mysql-studio/api')
  assert.deepEqual(ctx.injected, [['tools']], 'the tool registry is requested, and optional')

  const server = createServer((req, res) => { void route.handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { ctx, server, base }
}

/** One API call over real HTTP, mirroring the browser half's client. */
async function call(base, method, params) {
  const response = await fetch(`${base}/mysql-studio/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  })
  return { status: response.status, body: await response.json() }
}

const mounted = await mount()
test.after(async () => {
  await new Promise(resolve => mounted.server.close(resolve))
  for (const dispose of mounted.ctx.effects) {
    if (typeof dispose === 'function') dispose()
  }
  await rm(scratch, { recursive: true, force: true })
})

// ── route plumbing ──────────────────────────────────────────────────────────

test('health reports the plugin and its store location', async () => {
  const { status, body } = await call(mounted.base, 'health')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.result.plugin, 'dsh-mysql-studio')
  assert.match(body.result.storePath, /mysql-studio[\\/]connections\.json$/)
})

test('an unknown method is a 404 in the standard envelope', async () => {
  const { status, body } = await call(mounted.base, 'nope.nothing')
  assert.equal(status, 404)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'not-found')
})

test('only POST is served on the API prefix', async () => {
  const response = await fetch(`${mounted.base}/mysql-studio/api/health`, { method: 'GET' })
  assert.equal(response.status, 405)
  assert.equal((await response.json()).error.code, 'method-not-allowed')
})

test('a malformed body is rejected with the reason, not a stack', async () => {
  const response = await fetch(`${mounted.base}/mysql-studio/api/conn.save`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ this is not json',
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.match(body.error.message, /JSON/)
})

test('an unknown connection id is named before any argument validation', async () => {
  const { status, body } = await call(mounted.base, 'data.rows', { id: 'no-such-id' })
  assert.equal(status, 400)
  assert.match(body.error.message, /未知的连接 id/)
})

test('a missing required argument names the argument', async () => {
  // The connection has to resolve first, so this uses a real saved profile and
  // then omits the argument under test.
  const saved = await call(mounted.base, 'conn.save', { draft: { name: 'argcheck', host: 'h', user: 'u' } })
  const id = saved.body.result.connection.id
  const { status, body } = await call(mounted.base, 'data.rows', { id })
  assert.equal(status, 400)
  assert.match(body.error.message, /database/)
  await call(mounted.base, 'conn.delete', { id })
})

test('the fence refuses a request whose Host is not the served browser', async () => {
  // `fetch` refuses to set Host (a forbidden header), so this one goes raw.
  const port = mounted.server.address().port
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mysql-studio/api/health', method: 'POST', headers: { host: 'evil.example.com' } },
      res => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(result.status, 403)
  assert.equal(result.body.error.code, 'forbidden')
})

test('a loopback Host with a port is trusted', async () => {
  const port = mounted.server.address().port
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/mysql-studio/api/health', method: 'POST', headers: { host: `localhost:${port}` } },
      res => {
        let text = ''
        res.on('data', chunk => { text += chunk })
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
      },
    )
    req.on('error', reject)
    req.end('{}')
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
})

// ── connection profiles over the wire ───────────────────────────────────────

test('a connection round-trips through the API without leaking its password', async () => {
  const saved = await call(mounted.base, 'conn.save', {
    draft: { name: 'wire', host: '10.1.2.3', port: 3307, user: 'root', password: 'topsecret' },
  })
  assert.equal(saved.status, 200)
  const profile = saved.body.result.connection
  assert.equal(profile.password, undefined, 'the renderer never receives the secret')
  assert.equal(profile.hasPassword, true)

  const listed = await call(mounted.base, 'conn.list')
  assert.equal(listed.body.result.connections.length, 1)
  assert.equal(listed.body.result.connections[0].name, 'wire')

  // A URL paste expands into the same field vocabulary.
  const parsed = await call(mounted.base, 'conn.parseUrl', { url: 'jdbc:mysql://h:3307/db?user=u&password=p&useSSL=true' })
  assert.equal(parsed.body.result.draft.host, 'h')
  assert.equal(parsed.body.result.draft.user, 'u')
  assert.equal(parsed.body.result.draft.ssl.mode, 'required')

  const removed = await call(mounted.base, 'conn.delete', { id: profile.id })
  assert.equal(removed.body.result.ok, true)
  assert.equal((await call(mounted.base, 'conn.list')).body.result.connections.length, 0)
})

// ── live MySQL over the wire ────────────────────────────────────────────────

test('the full read path works over HTTP against the live server', async t => {
  // Parse the test URL through the API itself, which also proves the URL entry
  // point produces a profile the connection path accepts.
  const parsed = await call(mounted.base, 'conn.parseUrl', { url: LIVE_URL })
  const draft = { name: 'live', connectTimeoutMs: 8000, ...parsed.body.result.draft }

  const probe = await call(mounted.base, 'conn.test', { draft })
  if (probe.body.ok !== true) {
    t.skip(`MySQL unreachable: ${probe.body.error?.message ?? 'unknown'}`)
    return
  }
  assert.equal(probe.body.result.ok, true)
  assert.equal(typeof probe.body.result.version, 'string')
  console.log(`  ↳ HTTP conn.test: MySQL ${probe.body.result.version} in ${probe.body.result.latencyMs}ms`)

  const saved = await call(mounted.base, 'conn.save', { draft })
  const id = saved.body.result.connection.id
  assert.equal(saved.body.result.connection.hasPassword, true)

  const databases = await call(mounted.base, 'catalog.databases', { id })
  assert.equal(databases.status, 200)
  const userDatabases = databases.body.result.databases.filter(entry => !entry.system)
  assert.ok(userDatabases.length > 0)
  console.log(`  ↳ HTTP catalog.databases: ${databases.body.result.databases.length} schemas`)

  // Walk to a table that actually holds rows so paging is exercised.
  let target
  let database
  for (const candidate of userDatabases) {
    const tables = await call(mounted.base, 'catalog.tables', { id, database: candidate.name })
    const populated = tables.body.result.tables
      .filter(entry => entry.type === 'BASE TABLE' && (entry.estimatedRows ?? 0) > 1)
      .sort((a, b) => (b.estimatedRows ?? 0) - (a.estimatedRows ?? 0))[0]
    if (populated !== undefined) {
      database = candidate.name
      target = populated
      break
    }
  }
  if (target === undefined) {
    t.skip('no populated user table')
    return
  }

  const columns = await call(mounted.base, 'catalog.columns', { id, database, table: target.name })
  assert.ok(columns.body.result.columns.length > 0)

  const page = await call(mounted.base, 'data.rows', { id, database, table: target.name, limit: 3, offset: 0 })
  const result = page.body.result
  assert.equal(result.database, database)
  assert.equal(result.table, target.name)
  assert.equal(result.columns.length, columns.body.result.columns.length)
  assert.ok(result.rows.length <= 3)
  assert.ok(result.rows.every(row => row.length === result.columns.length))
  assert.equal(JSON.stringify(result).includes('undefined'), false, 'every cell is JSON-lossless')
  console.log(`  ↳ HTTP data.rows: ${database}.${target.name} → ${result.rows.length} rows, pk=${result.primaryKey.join(',') || 'none'}`)

  if (result.hasMore) {
    const next = await call(mounted.base, 'data.rows', { id, database, table: target.name, limit: 3, offset: 3 })
    assert.notDeepEqual(next.body.result.rows[0], result.rows[0])
  }

  const query = await call(mounted.base, 'query.run', { id, database, sql: 'SELECT VERSION() AS v', limit: 5 })
  assert.equal(query.body.result.rows.length, 1)
  assert.equal(typeof query.body.result.elapsedMs, 'number')

  // The read-only guard is enforced at the API boundary, not only in the module.
  const write = await call(mounted.base, 'query.run', { id, database, sql: 'DROP TABLE nope' })
  assert.equal(write.status, 400)
  assert.match(write.body.error.message, /只读/)

  await call(mounted.base, 'conn.delete', { id })
})

test('query.exec previews writes and schema APIs create through HTTP', async t => {
  const parsed = await call(mounted.base, 'conn.parseUrl', { url: LIVE_URL })
  const draft = { name: 'schema-api', connectTimeoutMs: 8000, ...parsed.body.result.draft }
  const probe = await call(mounted.base, 'conn.test', { draft })
  if (probe.body.ok !== true) {
    t.skip(`MySQL unreachable: ${probe.body.error?.message ?? 'unknown'}`)
    return
  }
  const saved = await call(mounted.base, 'conn.save', { draft })
  const id = saved.body.result.connection.id
  const database = '__dsh_ms_api_' + Date.now().toString(36)
  try {
    const preview = await call(mounted.base, 'schema.createDatabase', {
      id, name: database, charset: 'utf8mb4', dryRun: true,
    })
    assert.equal(preview.body.result.needsConfirm, true)
    assert.match(preview.body.result.sql, new RegExp('CREATE DATABASE `' + database + '`'))

    const created = await call(mounted.base, 'schema.createDatabase', {
      id, name: database, charset: 'utf8mb4', confirmSql: preview.body.result.sql,
    })
    assert.equal(created.status, 200)
    assert.equal(created.body.result.kind, 'ddl')

    const tableColumns = [
      { name: 'id', type: 'INT', nullable: false, primaryKey: true, autoIncrement: true },
      { name: 'name', type: 'VARCHAR(32)', nullable: false },
    ]
    const tablePreview = await call(mounted.base, 'schema.createTable', {
      id, database, name: 't', columns: tableColumns, dryRun: true,
    })
    const table = await call(mounted.base, 'schema.createTable', {
      id, database, name: 't', columns: tableColumns, confirmSql: tablePreview.body.result.sql,
    })
    assert.equal(table.status, 200)

    const refused = await call(mounted.base, 'schema.createTable', {
      id, database, sql: 'DROP TABLE t',
    })
    assert.equal(refused.status, 400)
    assert.match(refused.body.error.message, /CREATE TABLE/)

    const read = await call(mounted.base, 'query.exec', { id, database, sql: 'SELECT 1 AS n', limit: 5 })
    assert.equal(read.body.result.kind, 'read')
    assert.equal(read.body.result.rows[0][0], 1)

    const pending = await call(mounted.base, 'query.exec', {
      id, database, sql: "INSERT INTO t (name) VALUES ('via-api')",
    })
    assert.equal(pending.body.result.needsConfirm, true)

    const stillReadOnly = await call(mounted.base, 'query.run', {
      id, database, sql: "INSERT INTO t (name) VALUES ('nope')",
    })
    assert.equal(stillReadOnly.status, 400)
    assert.match(stillReadOnly.body.error.message, /只读/)

    const executed = await call(mounted.base, 'query.exec', {
      id, database, sql: pending.body.result.sql, confirmSql: pending.body.result.sql,
    })
    assert.equal(executed.body.result.kind, 'write')
    assert.equal(executed.body.result.affectedRows, 1)
  } finally {
    await call(mounted.base, 'query.exec', {
      id,
      database: 'mysql',
      sql: `DROP DATABASE IF EXISTS \`${database}\``,
      confirmSql: `DROP DATABASE IF EXISTS \`${database}\``,
    }).catch(() => {})
    await call(mounted.base, 'conn.delete', { id })
  }
})

// ── the write path over the wire ────────────────────────────────────────────

/**
 * Build the scratch table through a DIRECT pool, then exercise every mutation
 * through the HTTP API — so the test proves the route wiring, not the data layer
 * (which `write.test.mjs` already covers).
 */
test('mutations commit, conflict, and roll back over HTTP', async t => {
  const PROBE = '__dsh_mysql_studio_api_probe'
  const parsed = await call(mounted.base, 'conn.parseUrl', { url: LIVE_URL })
  const registry = new PoolRegistry()
  let pool
  try {
    pool = await registry.poolFor(normalizeProfile({ name: 'api-probe', connectTimeoutMs: 8000, ...parsed.body.result.draft }))
    await listDatabases(pool)
  } catch (error) {
    await registry.closeAll()
    t.skip(`MySQL unreachable: ${error.message}`)
    return
  }

  const databases = await listDatabases(pool)
  const database = databases.some(entry => entry.name === 'case_test' && !entry.system)
    ? 'case_test'
    : databases.find(entry => !entry.system).name

  try {
    await pool.query(`DROP TABLE IF EXISTS \`${database}\`.\`${PROBE}\``)
    await pool.query(
      `CREATE TABLE \`${database}\`.\`${PROBE}\` (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32) NOT NULL, qty INT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    )
    await pool.query(`INSERT INTO \`${database}\`.\`${PROBE}\` (id, name, qty) VALUES (1, 'alpha', 1), (2, 'beta', 2)`)

    const saved = await call(mounted.base, 'conn.save', { draft: { name: 'api-live', ...parsed.body.result.draft } })
    const id = saved.body.result.connection.id
    const scope = { id, database, table: PROBE }

    // A dry run over HTTP reports the statements and writes nothing.
    const preview = await call(mounted.base, 'data.mutate', {
      ...scope,
      concurrency: 'pk-changed',
      dryRun: true,
      mutations: [{ kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha', qty: 1 } }],
    })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.result.dryRun, true)
    assert.equal(preview.body.result.statements.length, 1)
    assert.match(preview.body.result.statements[0], /SET `name` = 'ALPHA'/)
    const [untouched] = await pool.query(`SELECT name FROM \`${database}\`.\`${PROBE}\` WHERE id = 1`)
    assert.equal(untouched[0].name, 'alpha')

    // A real commit lands.
    const committed = await call(mounted.base, 'data.mutate', {
      ...scope,
      concurrency: 'pk-changed',
      mutations: [{ kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha', qty: 1 } }],
    })
    assert.equal(committed.body.result.committed, true)
    assert.equal(committed.body.result.results[0].affectedRows, 1)

    // The read path agrees.
    const after = await call(mounted.base, 'data.rows', { ...scope, limit: 10, offset: 0 })
    assert.deepEqual(after.body.result.rows.map(row => row[1]), ['ALPHA', 'beta'])

    // Someone else moves row 2, so our stale original must be refused — and the
    // envelope must carry the machine-readable code, not just a message.
    await pool.query(`UPDATE \`${database}\`.\`${PROBE}\` SET name = 'moved' WHERE id = 2`)
    const conflict = await call(mounted.base, 'data.mutate', {
      ...scope,
      concurrency: 'pk-changed',
      mutations: [
        { kind: 'update', key: { id: 1 }, set: { name: 'FIRST' }, original: { id: 1, name: 'ALPHA', qty: 1 } },
        { kind: 'update', key: { id: 2 }, set: { name: 'BETA' }, original: { id: 2, name: 'beta', qty: 2 } },
      ],
    })
    assert.equal(conflict.status, 400)
    assert.equal(conflict.body.error.code, 'conflict')
    assert.match(conflict.body.error.message, /已被他人改动/)

    // Atomicity across the wire: the first, valid mutation must not have survived.
    const rolledBack = await call(mounted.base, 'data.rows', { ...scope, limit: 10, offset: 0 })
    assert.deepEqual(rolledBack.body.result.rows.map(row => row[1]), ['ALPHA', 'moved'])

    // Insert and delete round-trip too.
    const inserted = await call(mounted.base, 'data.mutate', {
      ...scope,
      mutations: [{ kind: 'insert', values: { name: 'gamma', qty: 3 } }],
    })
    assert.equal(inserted.body.result.results[0].kind, 'insert')

    const deleted = await call(mounted.base, 'data.mutate', {
      ...scope,
      concurrency: 'pk',
      mutations: [{ kind: 'delete', key: { id: 2 }, original: { id: 2 } }],
    })
    assert.equal(deleted.body.result.results[0].affectedRows, 1)

    // A keyless table is refused with a reason, over the wire.
    await pool.query(`DROP TABLE IF EXISTS \`${database}\`.\`${PROBE}_keyless\``)
    await pool.query(`CREATE TABLE \`${database}\`.\`${PROBE}_keyless\` (a INT NULL) ENGINE=InnoDB`)
    const keyless = await call(mounted.base, 'data.mutate', {
      id,
      database,
      table: `${PROBE}_keyless`,
      mutations: [{ kind: 'update', key: { a: 1 }, set: { a: 2 }, original: { a: 1 } }],
    })
    assert.equal(keyless.status, 400)
    assert.match(keyless.body.error.message, /没有主键/)

    await call(mounted.base, 'conn.delete', { id })
  } finally {
    await pool.query(`DROP TABLE IF EXISTS \`${database}\`.\`${PROBE}\``).catch(() => {})
    await pool.query(`DROP TABLE IF EXISTS \`${database}\`.\`${PROBE}_keyless\``).catch(() => {})
    await registry.closeAll()
  }
})

// ── upgrading from a document that carries a removed transport ──────────────

test('a stored Socket profile fails loudly instead of dialling localhost', async () => {
  // The upgrade path, end to end and through the real route. 0.5.0 stored a socket
  // connection with NO host key (host was optional for that transport); 0.6.0
  // removed the transport. Writing the old document straight to disk is the only
  // way to reach that state — the current API would never produce it.
  //
  // What is asserted is WHICH failure the reader gets. Before the guard, the
  // profile's undefined host reached mysql2, which defaults it to `localhost`: the
  // call either failed with a bare ECONNREFUSED or — on a machine running its own
  // MySQL with matching credentials — connected to the WRONG database and said
  // nothing at all. A message naming the removed transport is the fix.
  //
  // The path comes from `storePath()` rather than from this file's scratch dir:
  // several test files set DSH_HOME, and under `--test-isolation=none` they share
  // one process, so whichever ran last owns it. Asking the module resolves to the
  // same place the plugin will read, so the test is order-independent.
  const storePath = storePathFromLib()
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify({
    version: 1,
    connections: [{
      id: 'legacy-socket-1',
      name: 'legacy-socket',
      transport: 'socket',
      socketPath: '/var/run/mysqld/mysqld.sock',
      port: 3306,
      user: 'root',
      password: 'pw',
      ssl: { mode: 'disabled' },
      connectTimeoutMs: 10000,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  }, null, 2), 'utf8')

  // It still LISTS: one un-dialable row must not make the whole list unusable.
  const listed = await call(mounted.base, 'conn.list')
  assert.equal(listed.body.result.connections.length, 1)
  assert.equal(listed.body.result.connections[0].name, 'legacy-socket')
  assert.equal(listed.body.result.connections[0].host, undefined)

  // Every path that would dial it refuses, and says why.
  for (const [method, params] of [
    ['conn.test', { id: 'legacy-socket-1' }],
    ['catalog.databases', { id: 'legacy-socket-1' }],
    ['data.rows', { id: 'legacy-socket-1', database: 'x', table: 'y' }],
  ]) {
    const response = await call(mounted.base, method, params)
    assert.equal(response.status, 400, `${method} must refuse`)
    assert.match(response.body.error.message, /没有主机/, `${method} names the real cause`)
    // The point of the guard, asserted precisely: the refusal is OURS, not the
    // driver's. A mysql2 failure surfaces its own code (ECONNREFUSED and friends),
    // so `request-failed` is what proves mysql2 was never handed a host at all.
    // (Grepping the message for "localhost" would not: the guard's own wording
    // explains what localhost would have meant.)
    assert.equal(response.body.error.code, 'request-failed',
      `${method} must fail on our guard, not inside the driver — got ${response.body.error.code}`)
  }

  // Editing it into a real TCP connection is the way out the message points at,
  // and the socket leftovers do not survive that save.
  const saved = await call(mounted.base, 'conn.save', {
    draft: { id: 'legacy-socket-1', host: '127.0.0.1', port: 3306, name: 'legacy-socket' },
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body.error ?? {}))
  assert.equal(saved.body.result.connection.host, '127.0.0.1')
  assert.equal(saved.body.result.connection.socketPath, undefined)
  assert.equal(saved.body.result.connection.transport, undefined)

  await call(mounted.base, 'conn.delete', { id: 'legacy-socket-1' })
})
