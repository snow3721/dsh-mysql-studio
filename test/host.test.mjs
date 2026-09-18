/**
 * dsh-mysql-studio — host-half tests.
 *
 * Two layers:
 *
 * - **Offline** (`store`/guard): URL parsing, profile normalization, and the
 *   read-only statement guard. These run everywhere.
 * - **Live**: connect, introspect, page, and query the MySQL instance named by
 *   `DSH_MYSQL_STUDIO_TEST_URL`. Skipped — not failed — when it is unreachable,
 *   so the suite stays honest on a machine without a database.
 *
 * The store writes under `DSH_HOME`, which this file points at a scratch
 * directory so a test run never touches the real profile document.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const scratch = await mkdtemp(join(tmpdir(), 'mysql-studio-test-'))
process.env.DSH_HOME = scratch

const {
  ConnectionStore,
  connectionOptions,
  normalizeProfile,
  parseConnectionUrl,
  publicProfile,
  quoteId,
  resolvePassword,
} = await import('../lib/store.js')
const {
  assertCreateDatabaseSql,
  assertCreateTableSql,
  assertReadOnly,
  assertSingleStatement,
  buildCreateDatabaseSql,
  buildCreateTableSql,
  fetchRows,
  formatInsertSql,
  isSafeColumnType,
  listColumns,
  listDatabases,
  listTables,
  PoolRegistry,
  runQuery,
  runReadOnlyQuery,
  runSchemaChange,
  sqlLiteral,
  testProfile,
  toScalar,
} = await import('../lib/db.js')

const LIVE_URL = process.env.DSH_MYSQL_STUDIO_TEST_URL ?? 'mysql://root:root@192.168.100.128:3307'
const live = parseConnectionUrl(LIVE_URL)

test.after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

// ── Offline: URL parsing ────────────────────────────────────────────────────

test('parseConnectionUrl reads a native MySQL URI', () => {
  const draft = parseConnectionUrl('mysql://alice:s3cr3t@db.internal:3307/shop?charset=utf8mb4&ssl-mode=verify-ca')
  assert.equal(draft.host, 'db.internal')
  assert.equal(draft.port, 3307)
  assert.equal(draft.user, 'alice')
  assert.equal(draft.password, 's3cr3t')
  assert.equal(draft.database, 'shop')
  assert.equal(draft.charset, 'utf8mb4')
  assert.equal(draft.ssl.mode, 'verify-ca')
})

test('parseConnectionUrl reads a JDBC URL and its millisecond timeout', () => {
  const draft = parseConnectionUrl('jdbc:mysql://10.0.0.5:3306/erp?user=root&password=root&useSSL=true&connectTimeout=5000')
  assert.equal(draft.host, '10.0.0.5')
  assert.equal(draft.user, 'root')
  assert.equal(draft.password, 'root')
  assert.equal(draft.database, 'erp')
  assert.equal(draft.connectTimeoutMs, 5000)
  assert.equal(draft.ssl.mode, 'required')
})

test('parseConnectionUrl reads a bare host:port/db paste', () => {
  const draft = parseConnectionUrl('192.168.100.128:3307/case_test')
  assert.equal(draft.host, '192.168.100.128')
  assert.equal(draft.port, 3307)
  assert.equal(draft.database, 'case_test')
})

test('parseConnectionUrl returns nothing for unusable input instead of throwing', () => {
  assert.deepEqual(parseConnectionUrl(''), {})
  assert.deepEqual(parseConnectionUrl('   '), {})
})

test('parseConnectionUrl honors the native connect-timeout unit (seconds)', () => {
  assert.equal(parseConnectionUrl('mysql://u@h/db?connect-timeout=7').connectTimeoutMs, 7000)
})

// ── Offline: profile normalization ──────────────────────────────────────────

test('normalizeProfile fills defaults and mints an id', () => {
  const profile = normalizeProfile({ name: 'local', host: '127.0.0.1', user: 'root', password: 'root' })
  assert.match(profile.id, /^c[a-z0-9]+$/)
  assert.equal(profile.port, 3306)
  assert.equal(profile.ssl.mode, 'disabled')
  assert.equal(profile.connectTimeoutMs, 10000)
  assert.equal(profile.createdAt, profile.updatedAt)
})

test('normalizeProfile expands a url draft and lets explicit fields win', () => {
  const profile = normalizeProfile({
    url: 'mysql://alice:pw@host-a:3307/shop',
    port: 3310,
    name: 'override',
  })
  assert.equal(profile.host, 'host-a')
  assert.equal(profile.user, 'alice')
  assert.equal(profile.password, 'pw')
  assert.equal(profile.database, 'shop')
  assert.equal(profile.port, 3310)
  assert.equal(profile.name, 'override')
})

test('normalizeProfile keeps the stored password when a save omits it, and clears on empty', () => {
  const first = normalizeProfile({ host: 'h', user: 'u', password: 'kept' })
  const kept = normalizeProfile({ host: 'h', user: 'u', name: 'renamed' }, first)
  assert.equal(kept.password, 'kept')
  assert.equal(kept.id, first.id)
  const cleared = normalizeProfile({ host: 'h', user: 'u', password: '' }, first)
  assert.equal(cleared.password, '')
})

test('normalizeProfile rejects an incomplete draft', () => {
  assert.throws(() => normalizeProfile({ user: 'root' }), /host/)
  assert.throws(() => normalizeProfile({ host: 'h' }), /user/)
})

test('publicProfile never leaks the password', () => {
  const view = publicProfile({ id: 'c1', name: 'n', password: 'secret' })
  assert.equal('password' in view, false)
  assert.equal(view.hasPassword, true)
})

test('publicProfile never leaks leftover secrets from a pre-cut profile', () => {
  const view = publicProfile({
    id: 'c1',
    name: 'legacy',
    host: 'db.internal',
    user: 'root',
    password: 'dbsecret',
    transport: 'ssh',
    socketPath: '/tmp/mysql.sock',
    ssl: { mode: 'required', ca: 'CA', cert: 'CLIENTCERT', key: 'CLIENTKEY', passphrase: 'sslpass' },
    ssh: {
      host: 'jump',
      password: 'jumpsecret',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
      passphrase: 'keypass',
    },
  })

  assert.equal('password' in view, false)
  assert.equal(view.hasPassword, true)
  assert.equal('ssh' in view, false)
  assert.equal('socketPath' in view, false)
  assert.equal('transport' in view, false)

  const wire = JSON.stringify(view)
  for (const secret of ['dbsecret', 'jumpsecret', 'BEGIN OPENSSH', 'keypass', 'CLIENTCERT', 'CLIENTKEY', 'sslpass']) {
    assert.equal(wire.includes(secret), false, `"${secret}" must not reach the browser`)
  }

  assert.equal(view.ssl.mode, 'required')
  assert.equal(view.ssl.ca, 'CA')
})

test('resolvePassword prefers the named environment variable', () => {
  process.env.MYSQL_STUDIO_TEST_PW = 'from-env'
  assert.equal(resolvePassword({ password: 'stored', passwordEnv: 'MYSQL_STUDIO_TEST_PW' }), 'from-env')
  assert.equal(resolvePassword({ password: 'stored', passwordEnv: 'MYSQL_STUDIO_ABSENT_PW' }), 'stored')
  delete process.env.MYSQL_STUDIO_TEST_PW
})

test('connectionOptions maps TLS modes onto rejectUnauthorized', () => {
  const base = { host: 'h', port: 3306, user: 'u', password: '' }
  assert.equal(connectionOptions({ ...base, ssl: { mode: 'disabled' } }).ssl, undefined)
  assert.equal(connectionOptions({ ...base, ssl: { mode: 'required' } }).ssl.rejectUnauthorized, false)
  assert.equal(connectionOptions({ ...base, ssl: { mode: 'verify-ca' } }).ssl.rejectUnauthorized, true)
  assert.equal(connectionOptions({ ...base, ssl: { mode: 'preferred' } }).ssl.rejectUnauthorized, false)
})

// ── Offline: read-only guard ────────────────────────────────────────────────

test('assertReadOnly admits reads and rejects writes', () => {
  assert.match(assertReadOnly('SELECT 1'), /^SELECT 1$/)
  assert.match(assertReadOnly('  show tables  '), /^show tables$/)
  assert.match(assertReadOnly('WITH t AS (SELECT 1) SELECT * FROM t'), /^WITH/)
  assert.throws(() => assertReadOnly('UPDATE t SET a = 1'), /只读/)
  assert.throws(() => assertReadOnly('DELETE FROM t'), /只读/)
  assert.throws(() => assertReadOnly('DROP TABLE t'), /只读/)
  assert.throws(() => assertReadOnly('SELECT 1; DROP TABLE t'), /一条语句/)
  assert.throws(() => assertReadOnly('SELECT * FROM t FOR UPDATE'), /FOR UPDATE/)
  assert.throws(() => assertReadOnly('SELECT * FROM t INTO OUTFILE "/tmp/x"'), /OUTFILE/)
  assert.throws(() => assertReadOnly(''), /不能为空/)
})

test('assertReadOnly is not fooled by keywords inside literals or comments', () => {
  // The dangerous word lives in a string literal and inside a comment: neither
  // may decide the verdict.
  assert.match(assertReadOnly("SELECT 'update t set a=1' AS s"), /^SELECT/)
  assert.match(assertReadOnly('SELECT 1 -- delete from t'), /^SELECT 1/)
  assert.match(assertReadOnly('SELECT /* drop table t */ 1'), /^SELECT/)
})

test('assertReadOnly hands back the caller s own statement, literals intact', () => {
  // Regression: the guard used to return its stripped DECISION copy, and the
  // read path executed that — silently blanking every string literal, so
  // `WHERE name = 'bob'` ran as `WHERE name = ''` and simply matched nothing.
  for (const sql of [
    "SELECT * FROM t WHERE name = 'bob'",
    "SELECT * FROM t WHERE a = 'x' AND b = 1 -- trailing note",
    "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
    'SELECT "quoted" AS s',
    "SELECT ';' AS s",
  ]) {
    assert.equal(assertReadOnly(sql), sql, `must round-trip: ${sql}`)
  }
  // Only a trailing terminator is dropped.
  assert.equal(assertReadOnly('SELECT 1;'), 'SELECT 1')
  assert.equal(assertReadOnly('SELECT 1;;;  '), 'SELECT 1')
  // A semicolon inside a literal is not a second statement.
  assert.equal(assertReadOnly("SELECT 'a;b' AS s"), "SELECT 'a;b' AS s")
  // ...but one outside a literal still is.
  assert.throws(() => assertReadOnly("SELECT 1; SELECT 2"), /一条语句/)
})

test('assertReadOnly refuses a write hidden behind a reading verb', () => {
  // Two escapes that were once let through, and both of them actually execute.
  //
  // `WITH … DELETE` is valid MySQL 8 and starts with WITH, so a prefix check sees
  // a read — a data-modifying CTE really did delete a row through this guard, and
  // an UPDATE rewrote one. And `EXPLAIN ANALYZE`, unlike plain `EXPLAIN`, runs the
  // statement it analyses. Every case below is a write that must not pass.
  const writes = [
    ['data-modifying CTE', 'WITH cte AS (SELECT 1) DELETE FROM users'],
    ['CTE then UPDATE', 'WITH cte AS (SELECT 1) UPDATE users SET a = 1'],
    ['CTE then INSERT', 'WITH cte AS (SELECT 1) INSERT INTO users SELECT 1'],
    ['CTE then REPLACE', 'WITH cte AS (SELECT 1) REPLACE INTO users VALUES (1)'],
    ['recursive CTE then DELETE', 'WITH RECURSIVE t(n) AS (SELECT 1) DELETE FROM users'],
    ['two CTEs then DELETE', 'WITH a AS (SELECT 1), b AS (SELECT 2) DELETE FROM users'],
    ['EXPLAIN ANALYZE DELETE', 'EXPLAIN ANALYZE DELETE FROM users'],
    ['EXPLAIN ANALYZE with a CTE delete', 'EXPLAIN ANALYZE WITH c AS (SELECT 1) DELETE FROM users'],
    ['unparsable WITH fails closed', 'WITH bogus'],
  ]
  for (const [label, sql] of writes) {
    assert.throws(() => assertReadOnly(sql), `${label} must be refused: ${sql}`)
  }
})

test('assertReadOnly still admits the reads those checks must not break', () => {
  // The guard fails closed, so OVER-refusing is the real risk: each of these is an
  // ordinary read whose shape the CTE scanner has to get right. The column-list
  // form is here because a naive paren walk mis-reads `t(n)` as the CTE body.
  const reads = [
    'WITH cte AS (SELECT 1) SELECT * FROM cte',
    'WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b',
    'WITH RECURSIVE t(n) AS (SELECT 1) SELECT n FROM t',
    'WITH t(n) AS (SELECT 1) SELECT n FROM t',
    'WITH a AS (SELECT (1 + 2) AS x) SELECT x FROM a',
    'WITH a AS (SELECT 1) SELECT * FROM updates_log',
    'WITH a AS (\n  SELECT 1\n)\nSELECT * FROM a',
    'EXPLAIN ANALYZE SELECT * FROM t',
    'EXPLAIN ANALYZE WITH c AS (SELECT 1) SELECT * FROM c',
    'EXPLAIN DELETE FROM t',
    'SHOW TABLES',
    'DESCRIBE t',
    'SELECT 1',
  ]
  for (const sql of reads) {
    assert.equal(assertReadOnly(sql), sql, `must be admitted: ${sql}`)
  }
})

test('assertSingleStatement still refuses filesystem writes', () => {
  assert.throws(() => assertSingleStatement('SELECT 1 INTO OUTFILE "/tmp/x"'), /OUTFILE/)
  assert.throws(() => assertSingleStatement('LOAD DATA INFILE "/tmp/x" INTO TABLE t'), /LOAD DATA/)
  assert.throws(() => assertSingleStatement('SELECT 1; DROP TABLE t'), /一条语句/)
})

test('buildCreateDatabaseSql quotes the name and optional charset', () => {
  assert.equal(
    buildCreateDatabaseSql({ name: 'shop', charset: 'utf8mb4' }),
    'CREATE DATABASE `shop` CHARACTER SET `utf8mb4`',
  )
  assert.equal(
    buildCreateDatabaseSql({ name: 'shop', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }),
    'CREATE DATABASE `shop` CHARACTER SET `utf8mb4` COLLATE `utf8mb4_0900_ai_ci`',
  )
  assert.throws(() => buildCreateDatabaseSql({ name: 'bad-name' }), /库名/)
  assert.throws(() => buildCreateDatabaseSql({ name: '' }), /库名/)
})

test('buildCreateTableSql emits a keyed InnoDB table', () => {
  const sql = buildCreateTableSql({
    database: 'shop',
    name: 'users',
    columns: [
      { name: 'id', type: 'INT', nullable: false, primaryKey: true, autoIncrement: true },
      { name: 'name', type: 'VARCHAR(255)', nullable: false },
      { name: 'note', type: 'TEXT', nullable: true },
    ],
    charset: 'utf8mb4',
  })
  assert.match(sql, /^CREATE TABLE `shop`\.`users` \(/)
  assert.match(sql, /`id` INT NOT NULL AUTO_INCREMENT/)
  assert.match(sql, /`name` VARCHAR\(255\) NOT NULL/)
  assert.match(sql, /`note` TEXT NULL/)
  assert.match(sql, /PRIMARY KEY \(`id`\)/)
  assert.match(sql, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/)
  assert.throws(() => buildCreateTableSql({ database: 'shop', name: 't', columns: [] }), /至少定义一列/)
  assert.throws(() => buildCreateTableSql({
    database: 'shop', name: 't',
    columns: [{ name: 'x', type: 'ENUM(\'a\')' }],
  }), /类型不受支持/)
})

test('isSafeColumnType admits ordinary declarations and refuses injection', () => {
  assert.equal(isSafeColumnType('INT'), true)
  assert.equal(isSafeColumnType('VARCHAR(255)'), true)
  assert.equal(isSafeColumnType('DECIMAL(10, 2)'), true)
  assert.equal(isSafeColumnType('INT UNSIGNED'), true)
  assert.equal(isSafeColumnType("ENUM('a','b')"), false)
  assert.equal(isSafeColumnType('INT); DROP TABLE t; --'), false)
  assert.equal(isSafeColumnType(''), false)
})

test('assertCreate*Sql only admits the matching DDL verb', () => {
  assert.equal(assertCreateDatabaseSql('CREATE DATABASE foo'), 'CREATE DATABASE foo')
  assert.equal(assertCreateDatabaseSql('CREATE SCHEMA `foo`;'), 'CREATE SCHEMA `foo`')
  assert.throws(() => assertCreateDatabaseSql('DROP DATABASE foo'), /CREATE DATABASE/)
  assert.throws(() => assertCreateTableSql('CREATE DATABASE foo'), /CREATE TABLE/)
  assert.match(assertCreateTableSql('CREATE TABLE t (id INT)'), /CREATE TABLE/)
})

test('formatInsertSql quotes strings and leaves numbers and NULL alone', () => {
  const sql = formatInsertSql({
    database: 'shop',
    table: 'users',
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar' }, { name: 'note', type: 'text' }],
    rows: [
      [1, "O'Reilly", null],
      [2, 'plain', 'ok'],
    ],
  })
  assert.equal(
    sql,
    "INSERT INTO `shop`.`users` (`id`, `name`, `note`) VALUES\n  (1, 'O''Reilly', NULL),\n  (2, 'plain', 'ok');\n",
  )
  assert.equal(sqlLiteral(null), 'NULL')
  assert.equal(sqlLiteral('a\\b', { type: 'varchar' }), "'a\\\\b'")
  assert.throws(() => formatInsertSql({ columns: [{ name: 'id' }], rows: [] }), /没有可导出的行/)
})

test('toScalar keeps every value JSON-safe', () => {
  assert.equal(toScalar(null), null)
  assert.equal(toScalar(42), 42)
  assert.equal(toScalar('s'), 's')
  assert.equal(toScalar(true), true)
  assert.equal(toScalar(10n), '10')
  assert.equal(toScalar(new Date('2024-01-02T03:04:05Z')), '2024-01-02T03:04:05.000Z')
  assert.equal(toScalar(Buffer.from('hi')), Buffer.from('hi').toString('base64'))
  assert.equal(toScalar({ a: 1 }), '{"a":1}')
})

// ── Offline: store round-trip ───────────────────────────────────────────────

test('ConnectionStore saves, lists, updates, and removes', async () => {
  const store = new ConnectionStore()
  assert.deepEqual(await store.list(), [])

  const saved = await store.save({ name: 'primary', host: 'db', user: 'root', password: 'pw' })
  assert.equal((await store.list()).length, 1)
  assert.equal((await store.get(saved.id)).host, 'db')

  const updated = await store.save({ id: saved.id, port: 3307 })
  assert.equal(updated.id, saved.id)
  assert.equal(updated.port, 3307)
  assert.equal(updated.password, 'pw', 'password survives a partial save')
  assert.equal((await store.list()).length, 1)

  assert.equal(await store.remove(saved.id), true)
  assert.equal(await store.remove(saved.id), false)
  assert.deepEqual(await store.list(), [])
  await assert.rejects(() => store.save({ id: 'nope', host: 'h', user: 'u' }), /未知的连接 id/)
})

// ── Live: the real server ───────────────────────────────────────────────────

test('live server is reachable', async t => {
  if (live.host === undefined || live.user === undefined) {
    t.skip('no test URL configured')
    return
  }
  const profile = normalizeProfile({ name: 'live', connectTimeoutMs: 8000, ...live })
  let result
  try {
    result = await testProfile(profile)
  } catch (error) {
    t.skip(`MySQL ${live.host}:${live.port} unreachable: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  assert.equal(result.ok, true)
  assert.equal(typeof result.version, 'string')
  assert.ok(result.latencyMs >= 0)
  console.log(`  ↳ connected to MySQL ${result.version} as ${result.currentUser} in ${result.latencyMs}ms`)
})

test('live introspection and paging', async t => {
  if (live.host === undefined || live.user === undefined) {
    t.skip('no test URL configured')
    return
  }
  const profile = normalizeProfile({ name: 'live', connectTimeoutMs: 8000, ...live })
  const registry = new PoolRegistry()
  let pool
  try {
    pool = await registry.poolFor(profile)
    await listDatabases(pool)
  } catch (error) {
    t.skip(`MySQL ${live.host}:${live.port} unreachable: ${error instanceof Error ? error.message : String(error)}`)
    await registry.closeAll()
    return
  }
  try {
    const databases = await listDatabases(pool)
    assert.ok(databases.length > 0, 'at least one schema')
    assert.ok(databases.every(entry => typeof entry.name === 'string'))
    console.log(`  ↳ ${databases.length} schemas: ${databases.map(d => d.name).join(', ')}`)

    // Pick the first non-system schema that actually has a table, so the test
    // exercises the real path on whatever instance it is pointed at.
    let database
    let tables = []
    for (const candidate of databases.filter(entry => !entry.system)) {
      const found = await listTables(pool, candidate.name)
      if (found.length > 0) {
        database = candidate.name
        tables = found
        break
      }
    }
    if (database === undefined) {
      t.skip('no user schema with tables')
      return
    }
    console.log(`  ↳ ${database}: ${tables.length} relations`)

    const table = tables.find(entry => entry.type === 'BASE TABLE') ?? tables[0]
    // Prefer a table that actually holds rows: paging over an empty relation
    // would pass without exercising the windowing it exists to check.
    const populated = tables
      .filter(entry => entry.type === 'BASE TABLE' && (entry.estimatedRows ?? 0) > 1)
      .sort((a, b) => (b.estimatedRows ?? 0) - (a.estimatedRows ?? 0))[0]
    const target = populated ?? table
    const columns = await listColumns(pool, database, target.name)
    assert.ok(columns.length > 0, 'table has columns')
    assert.ok(columns.every(column => typeof column.name === 'string'))
    console.log(`  ↳ ${target.name}: ${columns.length} columns`)

    const page = await fetchRows(pool, { database, table: target.name, limit: 5, offset: 0 })
    assert.deepEqual(page.columns.map(column => column.name), columns.map(column => column.name))
    assert.ok(Array.isArray(page.primaryKey))
    assert.ok(page.rows.length <= 5)
    assert.ok(page.rows.every(row => row.length === page.columns.length))
    assert.ok(JSON.stringify(page).length > 0, 'the page is JSON-serializable')
    console.log(`  ↳ ${target.name}: fetched ${page.rows.length} rows (more: ${page.hasMore}, pk: ${page.primaryKey.join(',') || 'none'})`)

    // Paging must not repeat a keyed table's first page.
    if (page.primaryKey.length > 0 && page.rows.length > 1) {
      const second = await fetchRows(pool, { database, table: target.name, limit: 5, offset: 1 })
      assert.notDeepEqual(second.rows[0], page.rows[0], 'offset moves the window')
      assert.notEqual(second.rows[0][0], page.rows[0][0], 'a keyed table pages without overlap')
      console.log(`  ↳ offset 1 first key: ${JSON.stringify(second.rows[0][0])} (offset 0: ${JSON.stringify(page.rows[0][0])})`)
    }

    const queried = await runReadOnlyQuery(pool, { database, sql: 'SELECT 1 AS one, VERSION() AS v', limit: 10 })
    assert.equal(queried.rows.length, 1)
    assert.equal(queried.rows[0][0], 1)
    assert.equal(typeof queried.elapsedMs, 'number')

    // The guard validates a stripped copy of the statement; the ORIGINAL must be
    // what runs. If the stripped copy were executed instead, this literal would
    // come back as an empty string rather than as what was written.
    const literal = await runReadOnlyQuery(pool, { sql: "SELECT 'keep me' AS literal, 2 AS two", limit: 10 })
    assert.equal(literal.rows[0][0], 'keep me', 'string literals must survive the read-only guard')
    assert.equal(literal.rows[0][1], 2)

    await assert.rejects(() => runReadOnlyQuery(pool, { sql: 'DROP TABLE nope' }), /只读/)
  } finally {
    await registry.closeAll()
  }
})

test('schema change and confirmed SQL writes round-trip on a live server', async t => {
  const registry = new PoolRegistry()
  const profile = normalizeProfile({ name: 'schema-live', connectTimeoutMs: 8000, ...live })
  let pool
  try {
    pool = await registry.poolFor(profile)
    await listDatabases(pool)
  } catch (error) {
    await registry.closeAll()
    t.skip(`MySQL unreachable: ${error.message}`)
    return
  }

  const database = '__dsh_ms_' + Date.now().toString(36)
  const createDb = buildCreateDatabaseSql({ name: database, charset: 'utf8mb4' })
  const createTable = buildCreateTableSql({
    database,
    name: 't',
    columns: [
      { name: 'id', type: 'INT', nullable: false, primaryKey: true, autoIncrement: true },
      { name: 'name', type: 'VARCHAR(32)', nullable: false },
    ],
  })
  try {
    const previewDb = await runSchemaChange(pool, { sql: createDb, dryRun: true })
    assert.equal(previewDb.needsConfirm, true)
    assert.equal(previewDb.sql, createDb)
    const createdDb = await runSchemaChange(pool, { sql: createDb, confirmSql: createDb })
    assert.equal(createdDb.kind, 'ddl')

    const previewTable = await runSchemaChange(pool, { sql: createTable, database, dryRun: true })
    await runSchemaChange(pool, { sql: createTable, database, confirmSql: previewTable.sql })

    const read = await runQuery(pool, { database, sql: 'SELECT COUNT(*) AS n FROM t', limit: 5 })
    assert.equal(read.kind, 'read')
    assert.equal(Number(read.rows[0][0]), 0)

    const write = await runQuery(pool, { database, sql: "INSERT INTO t (name) VALUES ('alpha')" })
    assert.equal(write.needsConfirm, true)
    const mismatched = await runQuery(pool, {
      database,
      sql: "INSERT INTO t (name) VALUES ('alpha')",
      confirmSql: 'DROP TABLE t',
    })
    assert.equal(mismatched.needsConfirm, true, 'a mismatched confirm must not execute')

    const executed = await runQuery(pool, {
      database,
      sql: write.sql,
      confirmSql: write.sql,
    })
    assert.equal(executed.kind, 'write')
    assert.equal(executed.affectedRows, 1)

    const counted = await runQuery(pool, { database, sql: 'SELECT name FROM t', limit: 5 })
    assert.equal(counted.rows[0][0], 'alpha')
  } finally {
    try {
      await pool.query('USE mysql')
      await pool.query('DROP DATABASE IF EXISTS ' + quoteId(database))
    } catch {
      // The scratch schema is best-effort cleanup.
    }
    await registry.closeAll()
  }
})

test('pool registry rebuilds when a profile revision changes', async () => {
  const registry = new PoolRegistry()
  const first = normalizeProfile({ host: 'h', user: 'u', password: '' })
  // Inspecting the registry's key rather than opening a socket: the point is
  // that a saved edit is not served by the previous pool.
  const a = await registry.poolFor(first).catch(() => null)
  const rebuilt = { ...first, updatedAt: new Date(Date.now() + 1000).toISOString() }
  const b = await registry.poolFor(rebuilt).catch(() => null)
  assert.notEqual(a, b)
  await registry.closeAll()
})
