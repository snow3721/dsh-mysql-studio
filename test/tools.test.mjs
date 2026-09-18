/**
 * dsh-mysql-studio — model-facing tool tests.
 *
 * These tools are RAW `ToolDefinition` objects, which moves two obligations from
 * the framework onto this file:
 *
 *  1. `defineTool` would compile and assert the schemas; here they are written by
 *     hand, so `assertSupportedSchema` below re-implements the enforced JSON
 *     Schema subset (`packages/core/tools/src/json-schema.ts`) and checks every
 *     one. A schema outside the subset does not fail loudly at authoring time —
 *     it fails at `ctx.tools.register()`, i.e. at plugin load, in production.
 *
 *  2. `defineTool` would validate model arguments before `execute`. Here
 *     `execute` owns that, so bad arguments are tested as first-class inputs.
 *
 * The registry also validates every returned canonical value against
 * `output.schema` and turns a mismatch into an error result. `validateValue`
 * mirrors that check and is applied to every live result — this is the check that
 * caught the catalog envelopes carrying `collation` and `dataType` into a closed
 * schema, which in production would have made every call an error instead of an
 * answer.
 *
 * Resolution and validation are tested over a stub store and a recording pool
 * registry, so they assert what actually resolved instead of inferring it from a
 * connection timeout. Only the live section touches a real server, and it skips
 * (never fails) when that server is unreachable.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { createModelTools, registerModelTools } = await import('../lib/tools.js')
const { normalizeProfile, parseConnectionUrl } = await import('../lib/store.js')
const { listDatabases, PoolRegistry } = await import('../lib/db.js')

const LIVE_URL = process.env.DSH_MYSQL_STUDIO_TEST_URL ?? 'mysql://root:root@192.168.100.128:3307'

// ── the enforced JSON Schema subset ─────────────────────────────────────────

const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/** Whether a value is a plain object, the only thing a schema node may be. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Collect every way one schema node falls outside the subset DSH enforces.
 * @param node - the candidate schema node.
 * @param path - diagnostic path.
 * @param violations - accumulator.
 */
function checkSchema(node, path, violations) {
  if (!isRecord(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      violations.push(`${path}.${key} is not in the enforced subset`)
    }
  }
  const type = node.type
  if (type !== undefined && !SCHEMA_TYPES.has(type)) violations.push(`${path}.type "${type}" is unsupported`)
  if (node.oneOf !== undefined) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${path}.oneOf needs at least two branches`)
    } else {
      node.oneOf.forEach((branch, index) => checkSchema(branch, `${path}.oneOf[${index}]`, violations))
    }
  }
  if (node.properties !== undefined) {
    if (type !== 'object') violations.push(`${path}.properties requires type "object"`)
    if (!isRecord(node.properties)) violations.push(`${path}.properties must be an object`)
    else for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${path}.properties.${key}`, violations)
  }
  if (node.items !== undefined) {
    if (type !== 'array') violations.push(`${path}.items requires type "array"`)
    checkSchema(node.items, `${path}.items`, violations)
  }
  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) violations.push(`${path}.required must be an array`)
    else for (const key of node.required) {
      if (typeof key !== 'string') violations.push(`${path}.required must hold strings`)
      // The rule that actually bites: a required name with no declared property
      // can never be satisfied, so every value validation fails.
      else if (!isRecord(node.properties) || !Object.hasOwn(node.properties, key)) {
        violations.push(`${path}.required names "${key}", which is not in properties`)
      }
    }
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
  for (const keyword of ['enum', 'const']) {
    if (node[keyword] === undefined) continue
    if (type === undefined || !SCALAR_TYPES.has(type)) violations.push(`${path}.${keyword} requires a scalar type`)
  }
}

/** Assert one schema belongs to the subset, reporting every violation at once. */
function assertSupportedSchema(node, label) {
  const violations = []
  checkSchema(node, label, violations)
  assert.deepEqual(violations, [], `${label} must belong to the enforced subset`)
}

/**
 * Validate a value against an asserted schema, as the registry does before it
 * hands the value to `output.render`.
 * @param schema - the declared schema node.
 * @param value - the candidate value.
 * @param path - diagnostic path.
 * @returns violations in walk order; empty means valid.
 */
function validateValue(schema, value, path = 'value') {
  const violations = []
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(branch => validateValue(branch, value, path).length === 0)
    if (matches.length !== 1) violations.push(`${path} must match exactly one oneOf branch (matched ${matches.length})`)
    return violations
  }
  const type = schema.type
  if (type === undefined) return violations
  const fail = (expected) => violations.push(`${path} must be ${expected}, got ${JSON.stringify(value)}`)
  switch (type) {
    case 'object':
      if (!isRecord(value)) { fail('an object'); break }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(schema.properties ?? {}, key)) violations.push(`${path}.${key} is not declared`)
        }
      }
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (Object.hasOwn(value, key)) violations.push(...validateValue(child, value[key], `${path}.${key}`))
      }
      break
    case 'array':
      if (!Array.isArray(value)) { fail('an array'); break }
      if (schema.items !== undefined) {
        value.forEach((item, index) => violations.push(...validateValue(schema.items, item, `${path}[${index}]`)))
      }
      break
    case 'string': if (typeof value !== 'string') fail('a string'); break
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail('a number'); break
    case 'integer': if (!Number.isInteger(value)) fail('an integer'); break
    case 'boolean': if (typeof value !== 'boolean') fail('a boolean'); break
    case 'null': if (value !== null) fail('null'); break
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(`${path} must be one of ${JSON.stringify(schema.enum)}`)
  if (Object.hasOwn(schema, 'const') && value !== schema.const) violations.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  return violations
}

/** Assert a canonical value satisfies its tool's declared output schema. */
function assertValidOutput(definition, value) {
  const violations = validateValue(definition.output.schema, value, `${definition.name}.value`)
  assert.deepEqual(violations, [], `${definition.name} returned a value its own schema rejects`)
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Sentinel raised instead of dialling, so a test can prove resolution succeeded. */
const POOL_REACHED = 'POOL_REACHED'

/**
 * Tools over a fixed profile list and a pool registry that records and refuses.
 *
 * Nothing here touches the filesystem or the network, which is what makes the
 * resolution assertions exact: `resolved()` is the profile the tool actually
 * chose, rather than a guess drawn from which connection error came back.
 *
 * @param profiles - the profiles the stub store reports.
 * @returns the definitions, a caller, and the resolution record.
 */
function fixture(profiles = []) {
  const resolved = []
  const registry = {
    poolFor: async (profile) => {
      resolved.push(profile)
      throw new Error(POOL_REACHED)
    },
  }
  const definitions = createModelTools({ store: { list: async () => profiles }, registry })
  const map = new Map(definitions.map(definition => [definition.name, definition]))
  return {
    definitions,
    get: name => map.get(name),
    call: (name, args) => map.get(name).execute(args, { signal: new AbortController().signal }),
    resolved: () => resolved,
  }
}

/**
 * One realistic stored profile.
 *
 * Built through `normalizeProfile` so the tools meet the shape the real store
 * produces — including the minted id, which the caller cannot choose and which
 * is therefore read back rather than assumed.
 *
 * @param name - the display name.
 * @param host - the database host.
 * @param extra - any further profile fields.
 * @returns the normalized profile.
 */
function profile(name, host, extra = {}) {
  return normalizeProfile({ name, host, user: 'u', ...extra })
}

const surface = fixture()

// ── the declared surface ────────────────────────────────────────────────────

test('exactly three tools are published, and none of them writes', () => {
  assert.deepEqual(surface.definitions.map(definition => definition.name), ['mysql_connections', 'mysql_schema', 'mysql_query'])
  // The guarantee is structural rather than a naming convention: there is no
  // mutation entry point on this surface, so a prompt-injected instruction has
  // nothing to reach for.
  assert.equal(surface.get('mysql_mutate'), undefined)
  assert.equal(surface.definitions.some(definition => /mutate|insert|delete/i.test(definition.name)), false)
})

test('every parameter and output schema belongs to the enforced subset', () => {
  for (const definition of surface.definitions) {
    assertSupportedSchema(definition.parameters, `${definition.name}.parameters`)
    assertSupportedSchema(definition.output.schema, `${definition.name}.output.schema`)
    // The registry projects only name/description/parameters to the model, so all
    // three must be present and useful for the tool to be callable at all.
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${definition.name} needs a description the model can act on`)
    assert.equal(definition.parameters.type, 'object', 'parameters are an object root')
  }
  const query = surface.get('mysql_query')
  assert.deepEqual(Object.keys(query.parameters.properties).sort(), ['connection', 'database', 'limit', 'sql'])
  assert.equal('cursor' in query.parameters.properties, false)
})

test('the read-only tools declare themselves parallel-safe', () => {
  for (const definition of surface.definitions) assert.equal(definition.isConcurrencySafe({}), true)
})

test('no timeout is declared, because the driver takes no abort signal', () => {
  // Declaring `timeoutMs` asserts the tool forwards `exec.signal` into its work.
  // mysql2 accepts a per-statement server-side timeout, not an AbortSignal, so
  // claiming it would be a promise this plugin cannot keep.
  for (const definition of surface.definitions) assert.equal('timeoutMs' in definition, false)
})

// ── argument validation, which a raw definition owns ────────────────────────

test('a non-object argument payload is refused before anything is indexed', async () => {
  for (const definition of surface.definitions) {
    for (const args of [null, 'string', 42, ['a']]) {
      await assert.rejects(() => definition.execute(args, {}), /参数必须是一个对象/)
    }
  }
})

test('a missing or blank connection names the parameter', async () => {
  for (const name of ['mysql_schema', 'mysql_query']) {
    await assert.rejects(() => surface.call(name, {}), /缺少参数 connection/)
    await assert.rejects(() => surface.call(name, { connection: '   ', sql: 'SELECT 1' }), /缺少参数 connection/)
  }
})

test('mysql_query requires the statement itself', async () => {
  await assert.rejects(() => surface.call('mysql_query', { connection: 'x' }), /缺少参数 sql/)
})

test('a column lookup without its database says so instead of guessing', async () => {
  await assert.rejects(
    () => surface.call('mysql_schema', { connection: 'x', table: 'users' }),
    /查看表结构需要同时给出 database/,
  )
})

test('wrong argument types are named rather than coerced', async () => {
  await assert.rejects(() => surface.call('mysql_schema', { connection: 'x', database: 7 }), /参数 database 必须是字符串/)
  await assert.rejects(
    () => surface.call('mysql_query', { connection: 'x', sql: 'SELECT 1', limit: 'ten' }),
    /参数 limit 必须是数字/,
  )
})

test('an invalid call never costs a connection', async () => {
  // Validation runs before resolution, which is why a malformed call cannot open
  // a socket: nothing reached the registry.
  const only = profile('a', 'h1')
  const probe = fixture([only])
  await assert.rejects(() => probe.call('mysql_query', { connection: only.id }), /缺少参数 sql/)
  await assert.rejects(() => probe.call('mysql_schema', { connection: only.id, table: 't' }), /database/)
  assert.deepEqual(probe.resolved(), [])
})

test('the render reports a cap, not a next page', () => {
  const definition = fixture().get('mysql_query')
  const full = definition.output.render({}, {
    connection: 'c1', database: null, columns: [{ name: 'id', type: 'LONG', nullable: true }],
    rows: [[1], [2]], rowCount: 2, truncated: false, elapsedMs: 3, affectedRows: null,
  })[0].text
  assert.match(full, /2 rows/)
  assert.doesNotMatch(full, /cursor|more buffered|paged/)

  const capped = definition.output.render({}, {
    connection: 'c1', database: null, columns: [{ name: 'id', type: 'LONG', nullable: true }],
    rows: [[1]], rowCount: 1, truncated: true, elapsedMs: 3, affectedRows: null,
  })[0].text
  assert.match(capped, /1 row/)
  assert.match(capped, /row cap/)
  assert.match(capped, /narrow the query or aggregate/)
})

test('a statement the guard refuses never reaches the database', async () => {
  const only = profile('a', 'h1')
  const probe = fixture([only])
  // The data-modifying CTE is the one that matters here: `WITH … DELETE` is valid
  // MySQL 8 that STARTS with a reading keyword, and it was once accepted — a
  // demonstrated write through this exact code path. It is asserted at the model
  // surface, not only at the guard, because this is where prompt-injected text
  // arrives.
  const refused = [
    'WITH doomed AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM doomed)',
    'WITH c AS (SELECT 1) UPDATE t SET note = \'HACKED\'',
    'WITH c AS (SELECT 1) INSERT INTO t VALUES (1)',
    'EXPLAIN ANALYZE DELETE FROM t',
    'DROP TABLE whatever',
    'UPDATE t SET a = 1',
    'SELECT 1; DELETE FROM t',
    'SELECT * FROM t FOR UPDATE',
  ]
  for (const sql of refused) {
    await assert.rejects(
      () => probe.call('mysql_query', { connection: only.id, sql }),
      error => {
        assert.notEqual(error.message, POOL_REACHED, `${sql} must be refused before connecting`)
        assert.match(error.message, /只允许只读语句|只能执行一条语句|不允许|只能是 SELECT|EXPLAIN ANALYZE/)
        return true
      },
    )
  }
  // Refusing costs nothing: no pool.
  assert.deepEqual(probe.resolved(), [])
})

test('a legitimate CTE read is still allowed through to the database', async () => {
  const only = profile('a', 'h1')
  const probe = fixture([only])
  // The guard hardening must not have cost a real capability: a recursive CTE is
  // an ordinary read and has to get as far as the connection attempt.
  await assert.rejects(
    () => probe.call('mysql_query', { connection: only.id, sql: 'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t' }),
    new RegExp(POOL_REACHED),
  )
  assert.equal(probe.resolved().length, 1)
})

test('a cancelled call does not open a connection', async () => {
  const controller = new AbortController()
  controller.abort()
  const only = profile('a', 'h1')
  const probe = fixture([only])
  await assert.rejects(
    () => probe.get('mysql_query').execute({ connection: only.id, sql: 'SELECT 1' }, { signal: controller.signal }),
    /调用已取消/,
  )
  assert.deepEqual(probe.resolved(), [])
})

// ── connection resolution ───────────────────────────────────────────────────

test('with no connections saved, the model is told what to ask the user for', async () => {
  const value = await surface.call('mysql_connections', {})
  assertValidOutput(surface.get('mysql_connections'), value)
  assert.deepEqual(value.connections, [])
  const [block] = surface.get('mysql_connections').output.render({}, value)
  assert.equal(block.type, 'text')
  assert.match(block.text, /No MySQL connection is configured/)

  await assert.rejects(() => surface.call('mysql_query', { connection: 'nope', sql: 'SELECT 1' }), /尚未配置任何 MySQL 连接/)
})

test('an unknown connection lists the ones that exist', async () => {
  const alpha = profile('alpha', 'h1')
  const beta = profile('beta', 'h2')
  const probe = fixture([alpha, beta])
  await assert.rejects(() => probe.call('mysql_query', { connection: 'nope', sql: 'SELECT 1' }), error => {
    assert.match(error.message, /未知的连接 nope/)
    // The next call has to be able to succeed without a round trip through the
    // user, so the recoverable identifiers are in the failure itself.
    assert.match(error.message, new RegExp(`${alpha.id} \\(alpha\\)`))
    assert.match(error.message, new RegExp(`${beta.id} \\(beta\\)`))
    return true
  })
  assert.deepEqual(probe.resolved(), [])
})

test('a connection resolves by id, and by name when the name is unique', async () => {
  const alpha = profile('alpha', 'h1')
  const beta = profile('beta', 'h2')
  const probe = fixture([alpha, beta])
  await assert.rejects(() => probe.call('mysql_schema', { connection: beta.id }), new RegExp(POOL_REACHED))
  await assert.rejects(() => probe.call('mysql_schema', { connection: 'BeTa' }), new RegExp(POOL_REACHED))
  assert.deepEqual(
    probe.resolved().map(entry => entry.id),
    [beta.id, beta.id],
    'the name is matched case-insensitively',
  )
})

test('an id wins over a name, so an id is never ambiguous', async () => {
  // A profile NAMED after another profile's id would otherwise be able to hijack
  // it, which is why ids are checked first and exactly.
  const alpha = profile('alpha', 'h1')
  const impostor = profile(alpha.id, 'h2')
  const probe = fixture([alpha, impostor])
  await assert.rejects(() => probe.call('mysql_schema', { connection: alpha.id }), new RegExp(POOL_REACHED))
  assert.deepEqual(probe.resolved().map(entry => entry.id), [alpha.id])
})

test('a duplicated name asks for the id instead of picking one', async () => {
  const first = profile('dup', 'h1')
  const second = profile('DUP', 'h2')
  const probe = fixture([first, second])
  await assert.rejects(() => probe.call('mysql_schema', { connection: 'dup' }), error => {
    assert.match(error.message, /不唯一/)
    assert.match(error.message, new RegExp(first.id))
    assert.match(error.message, new RegExp(second.id))
    return true
  })
  assert.deepEqual(probe.resolved(), [], 'an ambiguous reference must not pick a connection')
})

test('not one of the leftover secrets reaches the model', async () => {
  const probe = fixture([normalizeProfile({
    id: 'c1',
    name: 'secretive',
    host: 'db.internal',
    user: 'root',
    password: 'dbsecret',
    transport: 'ssh',
    ssh: {
      host: 'jump',
      user: 'me',
      authMethod: 'privateKey',
      password: 'jumpsecret',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
      passphrase: 'keypass',
    },
  })])
  const definition = probe.get('mysql_connections')
  const value = await probe.call('mysql_connections', {})
  assertValidOutput(definition, value)

  assert.deepEqual(
    Object.keys(value.connections[0]).sort(),
    ['database', 'host', 'id', 'name', 'port', 'user'],
  )

  const wire = JSON.stringify(value) + JSON.stringify(definition.output.render({}, value))
  for (const secret of ['dbsecret', 'jumpsecret', 'OPENSSH PRIVATE KEY', 'keypass']) {
    assert.equal(wire.includes(secret), false, `${secret} must not reach the model`)
  }
  assert.equal('transport' in value.connections[0], false)
  assert.equal('viaJumpHost' in value.connections[0], false)
})

// ── registration ────────────────────────────────────────────────────────────

test('registration is effect-based, and lifts when the effect disposes', () => {
  const registered = []
  const toolsCtx = {
    tools: {
      register(definition) {
        registered.push(definition.name)
        return () => registered.splice(registered.indexOf(definition.name), 1)
      },
    },
    effect(fn) {
      this.dispose = fn()
    },
  }
  const ctx = { inject: (deps, fn) => { assert.deepEqual(deps, ['tools']); fn(toolsCtx) } }

  registerModelTools(ctx, { store: { list: async () => [] }, registry: {} })
  assert.deepEqual(registered, ['mysql_connections', 'mysql_schema', 'mysql_query'])
  toolsCtx.dispose()
  assert.deepEqual(registered, [], 'unloading the plugin must remove the tools')
})

test('a profile with no tool registry still loads the plugin', () => {
  // `tools` is reached through ctx.inject rather than the plugin's own inject
  // list, so a composition without dsh-tools keeps the workbench instead of
  // failing to load the whole plugin.
  let requested
  registerModelTools({ inject: (deps) => { requested = deps } }, { store: {}, registry: {} })
  assert.deepEqual(requested, ['tools'], 'the registry is an optional dependency')
})

// ── live MySQL ──────────────────────────────────────────────────────────────

// A real pool registry against the real server, over a stub store.
//
// The store is stubbed for isolation, not convenience: `ConnectionStore` resolves
// its document from the ambient `DSH_HOME`, and the suite runs every file in ONE
// process under `--test-isolation=none`, so a profile persisted here would appear
// inside another file's store. `api.test.mjs` already covers the real store end to
// end; what is under test here is the tool layer on top of it.
const registry = new PoolRegistry()
const live = normalizeProfile({ name: 'tools-live', connectTimeoutMs: 8000, ...parseConnectionUrl(LIVE_URL) })
const liveDefinitions = createModelTools({ store: { list: async () => [live] }, registry })
const liveByName = new Map(liveDefinitions.map(definition => [definition.name, definition]))

/** Drive one live tool the way the registry does. */
function callLive(name, args) {
  return liveByName.get(name).execute(args, { signal: new AbortController().signal })
}

const unreachable = await registry.poolFor(live)
  .then(pool => listDatabases(pool))
  .then(() => null)
  .catch(error => error.message)
if (unreachable !== null) console.log(`  (live tool tests skip: ${unreachable})`)

test.after(() => registry.closeAll())

test('mysql_schema walks schemas, then tables, then columns', async t => {
  if (unreachable !== null) return t.skip(unreachable)
  const definition = liveByName.get('mysql_schema')

  const schemas = await callLive('mysql_schema', { connection: live.id })
  assertValidOutput(definition, schemas)
  assert.equal(schemas.kind, 'schemas')
  assert.equal(schemas.database, null)
  assert.ok(schemas.schemas.some(row => row.system), 'information_schema and friends are flagged')
  const userSchemas = schemas.schemas.filter(row => !row.system)
  assert.ok(userSchemas.length > 0, 'the account must see at least one user schema')

  const database = userSchemas.some(row => row.name === 'case_test') ? 'case_test' : userSchemas[0].name
  const tables = await callLive('mysql_schema', { connection: live.id, database })
  assertValidOutput(definition, tables)
  assert.equal(tables.kind, 'tables')
  assert.equal(tables.database, database)
  if (tables.tables.length === 0) return t.skip(`${database} has no relations`)

  const table = tables.tables[0].name
  const columns = await callLive('mysql_schema', { connection: live.id, database, table })
  assertValidOutput(definition, columns)
  assert.equal(columns.kind, 'columns')
  assert.ok(columns.columns.length > 0)
  assert.match(definition.output.render({}, columns)[0].text, new RegExp(columns.columns[0].name))
  console.log(`  ↳ ${database}: ${tables.tables.length} relation(s); ${table} has ${columns.columns.length} column(s)`)
})

test('the connection list reports a normalized profile through the allowlist only', async t => {
  if (unreachable !== null) return t.skip(unreachable)
  const definition = liveByName.get('mysql_connections')
  const value = await callLive('mysql_connections', {})
  assertValidOutput(definition, value)

  const row = value.connections.find(entry => entry.id === live.id)
  const stored = parseConnectionUrl(LIVE_URL)
  assert.equal(row.host, stored.host)
  assert.equal(row.port, stored.port)
  // A substring check for the password is worthless against this fixture, where
  // the account is `root` and so is its password; the key set is what proves the
  // secret was never projected.
  assert.equal('password' in row, false)
  assert.deepEqual(
    Object.keys(row).sort(),
    ['database', 'host', 'id', 'name', 'port', 'user'],
  )
})

test('mysql_query returns rows the model can read, and its own schema accepts them', async t => {
  if (unreachable !== null) return t.skip(unreachable)
  const definition = liveByName.get('mysql_query')

  const value = await callLive('mysql_query', {
    connection: live.id,
    sql: "SELECT 1 AS n, 'kept' AS label, NULL AS nothing",
  })
  assertValidOutput(definition, value)
  assert.deepEqual(value.columns.map(column => column.name), ['n', 'label', 'nothing'])
  // The literal survives the read-only guard: the guard decides on a stripped
  // copy and executes the caller's own statement.
  assert.deepEqual(value.rows, [[1, 'kept', null]])
  assert.equal(value.truncated, false)

  const [block] = definition.output.render({}, value)
  assert.match(block.text, /columns: n, label, nothing/)
  assert.match(block.text, /\[1,"kept",null\]/, 'JSON rows keep NULL distinguishable from the text "NULL"')
})

test('a write is refused by the same guard the console uses', async t => {
  if (unreachable !== null) return t.skip(unreachable)
  for (const sql of ['DROP TABLE whatever', 'UPDATE t SET a = 1', 'SELECT 1; DELETE FROM t', 'SELECT * FROM t FOR UPDATE']) {
    await assert.rejects(() => callLive('mysql_query', { connection: live.id, sql }), error => {
      assert.match(error.message, /只允许只读语句|只能执行一条语句|不允许/)
      return true
    })
  }
})

test('a recursive CTE really runs against the server, and a modifying one does not', async t => {
  if (unreachable !== null) return t.skip(unreachable)
  const value = await callLive('mysql_query', {
    connection: live.id,
    sql: 'WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t',
  })
  assertValidOutput(liveByName.get('mysql_query'), value)
  assert.deepEqual(value.rows, [[1], [2], [3]], 'the guard hardening kept a real capability')

  await assert.rejects(
    () => callLive('mysql_query', {
      connection: live.id,
      sql: 'WITH doomed AS (SELECT 1) DELETE FROM __dsh_mysql_studio_probe WHERE 1 = 0',
    }),
    /只能是 SELECT/,
  )
})

test('an oversized limit is clamped, and truncated means there is no next page', async t => {
  if (unreachable !== null) return t.skip(unreachable)
  const definition = liveByName.get('mysql_query')
  const value = await callLive('mysql_query', {
    connection: live.id,
    sql: 'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS',
    limit: 99999,
  })
  assertValidOutput(definition, value)
  assert.equal(value.rowCount, 500, 'one call cannot exceed the row cap')
  assert.equal(value.truncated, true)
  assert.equal('cursor' in value, false)
  assert.equal('hasMore' in value, false)
  const text = definition.output.render({}, value)[0].text
  assert.match(text, /row cap/)
  assert.doesNotMatch(text, /cursor|more buffered/)

  const single = await callLive('mysql_query', { connection: live.id, sql: 'SELECT 1', limit: 0 })
  assert.equal(single.rowCount, 1, 'a nonsense floor clamps up to one row')
  assert.equal(single.truncated, false)
  console.log(`  ↳ limit 99999 -> 500 rows, truncated=${value.truncated}`)
})

test('a default schema lets the statement use unqualified names', async t => {
  if (unreachable !== null) return t.skip(unreachable)
  const value = await callLive('mysql_query', {
    connection: live.id,
    database: 'information_schema',
    sql: 'SELECT COUNT(*) AS n FROM TABLES',
  })
  assertValidOutput(liveByName.get('mysql_query'), value)
  assert.equal(value.database, 'information_schema')
  assert.equal(typeof value.rows[0][0], 'number')
})
