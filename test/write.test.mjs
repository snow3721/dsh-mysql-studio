/**
 * dsh-mysql-studio — write-path tests against a real MySQL server.
 *
 * These exercise `applyMutations` end to end: dry runs, single-cell updates,
 * inserts, deletes, optimistic-concurrency conflicts, and — the one that matters
 * most — that a commit is all-or-nothing when a later mutation in the same batch
 * fails.
 *
 * Everything happens on a scratch table named `__dsh_mysql_studio_probe`, which
 * this file creates and drops. It is dropped in a `finally`, so a failing
 * assertion cannot leave it behind. The whole file skips (never fails) when the
 * server is unreachable.
 *
 * The target schema is `case_test` when it exists — the name says what it is for
 * — and otherwise the first non-system schema the account can see.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { normalizeProfile, parseConnectionUrl } = await import('../lib/store.js')
const {
  applyMutations,
  fetchRows,
  listDatabases,
  MutationConflictError,
  PoolRegistry,
} = await import('../lib/db.js')

const LIVE_URL = process.env.DSH_MYSQL_STUDIO_TEST_URL ?? 'mysql://root:root@192.168.100.128:3307'
const PROBE = '__dsh_mysql_studio_probe'

/**
 * The scratch schema.
 *
 * Every statement is qualified with the target schema: these connections carry
 * no default database, so an unqualified CREATE would fail with "No database
 * selected" — and, worse, would look like an unreachable server.
 */
function ddlFor(database) {
  return [
    `DROP TABLE IF EXISTS \`${database}\`.\`${PROBE}\``,
    `CREATE TABLE \`${database}\`.\`${PROBE}\` (
       id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(64) NOT NULL,
       qty INT NULL,
       note VARCHAR(64) NULL,
       payload BLOB NULL,
       doubled INT GENERATED ALWAYS AS (qty * 2) STORED
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    `DROP TABLE IF EXISTS \`${database}\`.\`${PROBE}_keyless\``,
    `CREATE TABLE \`${database}\`.\`${PROBE}_keyless\` (
       a INT NULL,
       b VARCHAR(16) NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]
}

/** Connect, pick a schema, build the scratch tables. Returns null when unavailable. */
async function prepare() {
  const profile = normalizeProfile({ name: 'write-probe', connectTimeoutMs: 8000, ...parseConnectionUrl(LIVE_URL) })
  const registry = new PoolRegistry()
  try {
    const pool = await registry.poolFor(profile)
    const databases = await listDatabases(pool)
    const database = databases.some(entry => entry.name === 'case_test' && !entry.system)
      ? 'case_test'
      : databases.find(entry => !entry.system)?.name
    if (database === undefined) {
      await registry.closeAll()
      return null
    }
    for (const statement of ddlFor(database)) await pool.query(statement)
    return { pool, registry, database }
  } catch (error) {
    // Distinguish "server is not there" from "our own setup is broken": a silent
    // skip on the latter would hide a real bug behind a green suite.
    console.log(`  (write-test setup failed: ${error?.code ?? ''} ${error?.message ?? error})`)
    await registry.closeAll()
    return null
  }
}

/**
 * Reset the probe table to a known three rows.
 *
 * The ids are written EXPLICITLY: `DELETE` does not reset an AUTO_INCREMENT
 * counter, so a plain insert would hand out 4, 5, 6 on the second call and every
 * assertion that names a row by key would silently be talking about nothing.
 */
async function seed(pool, database) {
  await pool.query(`DELETE FROM \`${database}\`.\`${PROBE}\``)
  await pool.query(
    `INSERT INTO \`${database}\`.\`${PROBE}\` (id, name, qty, note) VALUES`
    + ` (1, 'alpha', 1, 'first'), (2, 'beta', 2, NULL), (3, 'gamma', 3, 'third')`,
  )
}

/** Read every row of the probe table in key order, as plain objects. */
async function readAll(pool, database) {
  const [rows] = await pool.query(`SELECT id, name, qty, note FROM \`${database}\`.\`${PROBE}\` ORDER BY id`)
  return rows.map(row => ({ id: row.id, name: row.name, qty: row.qty, note: row.note }))
}

const live = await prepare()
if (live === null) console.log('  (live MySQL unavailable — write tests will skip)')

test.after(async () => {
  if (live === null) return
  for (const statement of [
    `DROP TABLE IF EXISTS \`${live.database}\`.\`${PROBE}\``,
    `DROP TABLE IF EXISTS \`${live.database}\`.\`${PROBE}_keyless\``,
  ]) {
    await live.pool.query(statement).catch(() => {})
  }
  await live.registry.closeAll()
})

/** Skip the body when the server is not there, with one consistent message. */
function requireLive(t) {
  if (live === null) {
    t.skip('MySQL unreachable')
    return false
  }
  return true
}

// ── dry run ─────────────────────────────────────────────────────────────────

test('a dry run plans the statements and writes nothing', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  const result = await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    dryRun: true,
    mutations: [{ kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha' } }],
  })

  assert.equal(result.dryRun, true)
  assert.equal(result.committed, undefined)
  assert.equal(result.statements.length, 1)
  assert.match(result.statements[0], /^UPDATE `.*`\.`__dsh_mysql_studio_probe` SET `name` = 'ALPHA' WHERE `id` <=> 1 AND `name` <=> 'alpha'$/)

  const rows = await readAll(pool, database)
  assert.equal(rows[0].name, 'alpha', 'a dry run must not write')
})

// ── the three mutations ─────────────────────────────────────────────────────

test('an update writes the cell and reports one affected row', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  const result = await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    mutations: [{
      kind: 'update',
      key: { id: 2 },
      set: { qty: 20, note: 'second' },
      original: { id: 2, name: 'beta', qty: 2, note: null },
    }],
  })

  assert.equal(result.committed, true)
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].affectedRows, 1)

  const rows = await readAll(pool, database)
  assert.deepEqual(rows[1], { id: 2, name: 'beta', qty: 20, note: 'second' })
})

test('a NULL edit writes SQL NULL', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    mutations: [{
      kind: 'update',
      key: { id: 1 },
      set: { note: null },
      original: { id: 1, name: 'alpha', note: 'first' },
    }],
  })

  const rows = await readAll(pool, database)
  assert.equal(rows[0].note, null)
})

test('a value containing quotes round-trips intact', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  const tricky = "o'brien \"quoted\" \\ backslash"
  await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk',
    mutations: [{ kind: 'update', key: { id: 1 }, set: { note: tricky }, original: { id: 1 } }],
  })

  const rows = await readAll(pool, database)
  assert.equal(rows[0].note, tricky)
})

test('an insert adds a row and returns its id', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  const result = await applyMutations(pool, {
    database,
    table: PROBE,
    mutations: [{ kind: 'insert', values: { name: 'delta', qty: 4 } }],
  })

  assert.equal(result.results[0].kind, 'insert')
  assert.equal(typeof result.results[0].insertId, 'number')

  const rows = await readAll(pool, database)
  assert.equal(rows.length, 4)
  assert.equal(rows[3].name, 'delta')
})

test('a delete removes exactly the identified row', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  const result = await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    mutations: [{ kind: 'delete', key: { id: 2 }, original: { id: 2, name: 'beta' } }],
  })

  assert.equal(result.results[0].affectedRows, 1)
  const rows = await readAll(pool, database)
  assert.deepEqual(rows.map(row => row.id), [1, 3])
})

test('a batch of update, insert, and delete commits together', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  const result = await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    mutations: [
      { kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha' } },
      { kind: 'delete', key: { id: 3 }, original: { id: 3, name: 'gamma' } },
      { kind: 'insert', values: { name: 'delta', qty: 4 } },
    ],
  })

  assert.equal(result.statements.length, 3)
  assert.equal(result.results.length, 3)
  const rows = await readAll(pool, database)
  assert.deepEqual(rows.map(row => row.name), ['ALPHA', 'beta', 'delta'])
})

// ── no-ops ──────────────────────────────────────────────────────────────────

test('a batch made only of no-ops writes nothing and reports the skips', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  const result = await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    mutations: [{
      kind: 'update',
      key: { id: 1 },
      set: { name: 'alpha' },
      original: { id: 1, name: 'alpha' },
    }],
  })

  assert.deepEqual(result.statements, [])
  assert.deepEqual(result.skipped, [0])
  assert.equal(result.committed, undefined)
})

// ── conflicts and atomicity ─────────────────────────────────────────────────

test('a stale original is refused as a conflict', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  // Someone else edits the row after our page was loaded.
  await pool.query(`UPDATE \`${database}\`.\`${PROBE}\` SET note = 'moved' WHERE id = 1`)

  await assert.rejects(
    () => applyMutations(pool, {
      database,
      table: PROBE,
      concurrency: 'pk-changed',
      mutations: [{
        kind: 'update',
        key: { id: 1 },
        set: { note: 'mine' },
        original: { id: 1, name: 'alpha', note: 'first' },
      }],
    }),
    error => {
      assert.ok(error instanceof MutationConflictError, 'a conflict is its own error type')
      assert.equal(error.code, 'conflict')
      return true
    },
  )

  const rows = await readAll(pool, database)
  assert.equal(rows[0].note, 'moved', 'the losing write must not land')
})

test('the pk mode tolerates a concurrent change to an untouched column', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  await pool.query(`UPDATE \`${database}\`.\`${PROBE}\` SET note = 'moved' WHERE id = 1`)

  // `pk` identifies by key alone, so writing `name` still succeeds — that is the
  // documented meaning of the loosest mode, not an accident.
  const result = await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk',
    mutations: [{ kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1 } }],
  })
  assert.equal(result.results[0].affectedRows, 1)
  const rows = await readAll(pool, database)
  assert.equal(rows[0].name, 'ALPHA')
  assert.equal(rows[0].note, 'moved')
})

test('a failing mutation rolls back the whole batch', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  // Row 2 moves out from under us; row 1's update is perfectly valid.
  await pool.query(`UPDATE \`${database}\`.\`${PROBE}\` SET name = 'beta-moved' WHERE id = 2`)

  await assert.rejects(() => applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    mutations: [
      { kind: 'update', key: { id: 1 }, set: { name: 'ALPHA' }, original: { id: 1, name: 'alpha' } },
      { kind: 'update', key: { id: 2 }, set: { name: 'BETA' }, original: { id: 2, name: 'beta' } },
    ],
  }), /已被他人改动|不复存在/)

  const rows = await readAll(pool, database)
  assert.equal(rows[0].name, 'alpha', 'the first, valid write must not survive a later failure')
  assert.equal(rows[1].name, 'beta-moved')
})

test('deleting a row that is already gone is a conflict, not a silent success', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  await pool.query(`DELETE FROM \`${database}\`.\`${PROBE}\` WHERE id = 3`)

  await assert.rejects(() => applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk',
    mutations: [{ kind: 'delete', key: { id: 3 }, original: { id: 3 } }],
  }), error => error instanceof MutationConflictError)
})

// ── refusals that need a real schema ────────────────────────────────────────

test('a keyless table refuses edits and says why', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live

  await assert.rejects(() => applyMutations(pool, {
    database,
    table: `${PROBE}_keyless`,
    mutations: [{ kind: 'update', key: { a: 1 }, set: { b: 'x' }, original: { a: 1, b: 'y' } }],
  }), /没有主键/)
})

test('binary and generated columns are refused against the real table', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  const common = { database, table: PROBE, concurrency: 'pk', mutations: [] }

  await assert.rejects(() => applyMutations(pool, {
    ...common,
    mutations: [{ kind: 'update', key: { id: 1 }, set: { payload: 'x' }, original: { id: 1 } }],
  }), /二进制列/)

  await assert.rejects(() => applyMutations(pool, {
    ...common,
    mutations: [{ kind: 'update', key: { id: 1 }, set: { doubled: 9 }, original: { id: 1 } }],
  }), /生成列/)
})

test('an empty mutation list is refused rather than committing nothing', async t => {
  if (!requireLive(t)) return
  await assert.rejects(() => applyMutations(live.pool, {
    database: live.database,
    table: PROBE,
    mutations: [],
  }), /没有待提交的改动/)
})

// ── reads and writes agree ──────────────────────────────────────────────────

test('a committed edit is visible through the read path', async t => {
  if (!requireLive(t)) return
  const { pool, database } = live
  await seed(pool, database)

  await applyMutations(pool, {
    database,
    table: PROBE,
    concurrency: 'pk-changed',
    mutations: [{
      kind: 'update',
      key: { id: 1 },
      set: { name: 'alpha-renamed' },
      original: { id: 1, name: 'alpha' },
    }],
  })

  const page = await fetchRows(pool, { database, table: PROBE, limit: 10, offset: 0 })
  const nameAt = page.columns.findIndex(column => column.name === 'name')
  assert.deepEqual(page.rows.map(row => row[nameAt]), ['alpha-renamed', 'beta', 'gamma'])
  assert.deepEqual(page.primaryKey, ['id'])
})
