/**
 * dsh-mysql-studio — mutation builder tests.
 *
 * `buildMutationPlan` is the whole safety surface of the write path: it decides
 * which identifiers may appear, which values are bound rather than interpolated,
 * which rows the WHERE clause insists on, and which edits are no-ops. It is a
 * pure function precisely so all of that can be pinned down here, without a
 * database and without a browser.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { buildMutationPlan, CONCURRENCY_MODES, DEFAULT_CONCURRENCY, MutationConflictError } = await import('../lib/db.js')
const { quoteId } = await import('../lib/store.js')

const columns = [
  { name: 'id', columnType: 'int', extra: 'auto_increment' },
  { name: 'name', columnType: 'varchar(64)', extra: '' },
  { name: 'qty', columnType: 'int', extra: '' },
  { name: 'note', columnType: 'text', extra: '' },
  { name: 'payload', columnType: 'blob', extra: '' },
  { name: 'doubled', columnType: 'int', extra: 'STORED GENERATED' },
]
const columnMap = new Map(columns.map(column => [column.name, column]))
const base = { database: 'shop', table: 'orders', columnMap, primaryKey: ['id'], concurrency: 'pk' }

// ── shape ───────────────────────────────────────────────────────────────────

test('the exported vocabulary is stable', () => {
  assert.deepEqual(CONCURRENCY_MODES, ['pk', 'pk-changed'])
  assert.equal(DEFAULT_CONCURRENCY, 'pk-changed')
  assert.equal(new MutationConflictError('x').code, 'conflict')
})

test('an update under the pk mode writes the set and identifies by key alone', () => {
  const plan = buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set: { name: 'new' }, original: { id: 1, name: 'old' } },
  })
  assert.equal(plan.kind, 'update')
  assert.equal(plan.sql, 'UPDATE `shop`.`orders` SET `name` = ? WHERE `id` <=> ?')
  assert.deepEqual(plan.values, ['new', 1])
})

test('pk-changed widens the WHERE with the changed column s original value', () => {
  const plan = buildMutationPlan({
    ...base,
    concurrency: 'pk-changed',
    mutation: { kind: 'update', key: { id: 1 }, set: { name: 'new' }, original: { id: 1, name: 'old', qty: 5 } },
  })
  assert.equal(plan.sql, 'UPDATE `shop`.`orders` SET `name` = ? WHERE `id` <=> ? AND `name` <=> ?')
  assert.deepEqual(plan.values, ['new', 1, 'old'])
})

test('the removed pk-row mode degrades to pk-changed rather than failing', () => {
  // `pk-row` used to put every other column's original value in the WHERE clause.
  // It was removed; a client that still sends it (a cached bundle between the host
  // restarting and the browser refreshing) must not break the commit — it gets the
  // documented default. Asserted by the tightening rule that identifies pk-changed:
  // only `name` is written, so only `name` joins the WHERE.
  const plan = buildMutationPlan({
    ...base,
    concurrency: 'pk-row',
    mutation: {
      kind: 'update',
      key: { id: 1 },
      set: { name: 'new' },
      original: { id: 1, name: 'old', qty: 5, note: null, payload: null, doubled: 9 },
    },
  })
  assert.equal(plan.sql, 'UPDATE `shop`.`orders` SET `name` = ? WHERE `id` <=> ? AND `name` <=> ?')
  assert.deepEqual(plan.values, ['new', 1, 'old'])
})

test('pk-changed only tightens on the columns actually being written', () => {
  // `qty` is submitted but unchanged, so it must not appear in the WHERE: a
  // concurrent change to it is not a conflict for a commit that does not write it.
  const plan = buildMutationPlan({
    ...base,
    concurrency: 'pk-changed',
    mutation: {
      kind: 'update',
      key: { id: 1 },
      set: { name: 'new', qty: 5 },
      original: { id: 1, name: 'old', qty: 5 },
    },
  })
  assert.equal(plan.sql, 'UPDATE `shop`.`orders` SET `name` = ? WHERE `id` <=> ? AND `name` <=> ?')
  assert.deepEqual(plan.values, ['new', 1, 'old'])
})

test('renaming a key column keeps the ORIGINAL key in the WHERE', () => {
  const plan = buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set: { id: 2 }, original: { id: 1 } },
  })
  assert.equal(plan.sql, 'UPDATE `shop`.`orders` SET `id` = ? WHERE `id` <=> ?')
  assert.deepEqual(plan.values, [2, 1])
})

test('a delete identifies the row and writes nothing', () => {
  const plan = buildMutationPlan({ ...base, mutation: { kind: 'delete', key: { id: 7 } } })
  assert.equal(plan.sql, 'DELETE FROM `shop`.`orders` WHERE `id` <=> ?')
  assert.deepEqual(plan.values, [7])
})

test('an insert lists the given columns', () => {
  const plan = buildMutationPlan({ ...base, mutation: { kind: 'insert', values: { name: 'n', qty: 3 } } })
  assert.equal(plan.sql, 'INSERT INTO `shop`.`orders` (`name`, `qty`) VALUES (?, ?)')
  assert.deepEqual(plan.values, ['n', 3])
})

// ── no-op filtering ─────────────────────────────────────────────────────────

test('an edit that types the loaded value back is not a write', () => {
  assert.equal(buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set: { name: 'old' }, original: { id: 1, name: 'old' } },
  }), null)
})

test('no-op comparison is by text, so a numeric round trip is still a no-op', () => {
  assert.equal(buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set: { qty: '5' }, original: { id: 1, qty: 5 } },
  }), null)
})

test('an update whose every column is a no-op yields no plan, but one real change carries it', () => {
  const mutation = {
    kind: 'update',
    key: { id: 1 },
    set: { qty: 5, name: 'new' },
    original: { id: 1, qty: 5, name: 'old' },
  }
  const plan = buildMutationPlan({ ...base, mutation })
  assert.deepEqual(plan.values, ['new', 1])
})

// ── NULL handling ───────────────────────────────────────────────────────────

test('setting a cell to NULL binds a null parameter', () => {
  const plan = buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set: { note: null }, original: { id: 1, note: 'was' } },
  })
  assert.deepEqual(plan.values, [null, 1])
})

test('a NULL original still identifies the row, via the NULL-safe operator', () => {
  const plan = buildMutationPlan({
    ...base,
    concurrency: 'pk-changed',
    mutation: { kind: 'update', key: { id: 1 }, set: { name: 'y' }, original: { id: 1, name: null } },
  })
  assert.match(plan.sql, /`name` <=> \?/)
  assert.equal(plan.sql.includes('= NULL'), false)
  assert.deepEqual(plan.values, ['y', 1, null])
})

test('clearing a cell is a real edit, not a no-op against an empty string', () => {
  const plan = buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set: { note: '' }, original: { id: 1, note: null } },
  })
  assert.deepEqual(plan.values, ['', 1])
})

// ── value binding ───────────────────────────────────────────────────────────

test('booleans bind as 1/0 and numbers pass through unchanged', () => {
  const plan = buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set: { qty: true, name: 42 }, original: { id: 1 } },
  })
  // A number stays a number and lets the server coerce it into the column's own
  // type; only text is stringified.
  assert.deepEqual(plan.values, [1, 42, 1])
})

test('a value that looks like SQL is bound, never interpolated', () => {
  const payload = "x'; DROP TABLE orders; --"
  const plan = buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: "1 OR 1=1" }, set: { name: payload }, original: { id: 1 } },
  })
  assert.equal(plan.sql, 'UPDATE `shop`.`orders` SET `name` = ? WHERE `id` <=> ?')
  assert.equal(plan.sql.includes('DROP'), false)
  assert.deepEqual(plan.values, [payload, '1 OR 1=1'])
})

test('quoting escapes an embedded backtick', () => {
  assert.equal(quoteId('weird`name'), '`weird``name`')
})

// ── refusals ────────────────────────────────────────────────────────────────

test('a keyless table refuses update and delete', () => {
  const keyless = { ...base, primaryKey: [] }
  assert.throws(() => buildMutationPlan({
    ...keyless,
    mutation: { kind: 'update', key: {}, set: { name: 'x' }, original: {} },
  }), /没有主键/)
  assert.throws(() => buildMutationPlan({ ...keyless, mutation: { kind: 'delete', key: {} } }), /没有主键/)
})

test('a missing key column refuses the commit', () => {
  assert.throws(() => buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: {}, set: { name: 'x' }, original: { name: 'old' } },
  }), /缺少主键列 id/)
})

test('pk-changed refuses when the changed column has no original', () => {
  assert.throws(() => buildMutationPlan({
    ...base,
    concurrency: 'pk-changed',
    mutation: { kind: 'update', key: { id: 1 }, set: { name: 'x' }, original: { id: 1 } },
  }), /需要列 name 的原值/)
})

test('an unknown concurrency mode falls back to the documented default', () => {
  // Proven by the fallback's own requirement: `pk` would not need the original.
  assert.throws(() => buildMutationPlan({
    ...base,
    concurrency: 'whatever',
    mutation: { kind: 'update', key: { id: 1 }, set: { name: 'x' }, original: { id: 1 } },
  }), /需要列 name 的原值/)
})

test('unknown, binary, and generated columns are refused', () => {
  const attempt = set => () => buildMutationPlan({
    ...base,
    mutation: { kind: 'update', key: { id: 1 }, set, original: { id: 1 } },
  })
  assert.throws(attempt({ nope: 'x' }), /表里没有列 nope/)
  assert.throws(attempt({ payload: 'x' }), /二进制列 payload/)
  assert.throws(attempt({ doubled: 1 }), /生成列 doubled/)
})

test('an insert with no columns, and an unknown kind, are refused', () => {
  assert.throws(() => buildMutationPlan({ ...base, mutation: { kind: 'insert', values: {} } }), /至少要填一列/)
  assert.throws(() => buildMutationPlan({ ...base, mutation: { kind: 'truncate' } }), /未知的改动类型/)
})

test('identifiers that are not plain names are refused', () => {
  const mutation = { kind: 'delete', key: { id: 1 } }
  assert.throws(() => buildMutationPlan({ ...base, database: 'shop; DROP DATABASE x', mutation }), /非法的库名/)
  assert.throws(() => buildMutationPlan({ ...base, table: 'orders` WHERE 1=1', mutation }), /非法的表名/)
  assert.throws(() => buildMutationPlan({ ...base, database: '', mutation }), /非法的库名/)
})
