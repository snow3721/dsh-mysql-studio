/**
 * dsh-mysql-studio — model-facing tools.
 *
 * The workbench half of this plugin serves a human through one HTTP route. This
 * half serves the agent through the tool registry, over the SAME store, pool
 * registry, and query functions — so a connection the user configured in the UI
 * is the connection the model queries, and the read-only guard the console
 * enforces is the guard the model meets.
 *
 * Three tools, deliberately:
 *
 *   `mysql_connections`  what can I connect to?      (discovery)
 *   `mysql_schema`       what is in there?           (introspection)
 *   `mysql_query`        answer my question          (one guarded read)
 *
 * Every visible tool costs prompt tokens on every request, so browsing the
 * catalog is one progressive tool rather than three: no `database` lists
 * schemas, a `database` lists its relations, and `database` + `table` describes
 * columns.
 *
 * ## Read-only, by construction
 *
 * `mysql_query` runs through `assertReadOnly`, the same lexical gate as the
 * console, and there is no mutation tool here at all. The structured write path
 * stays where a human confirms it against a real SQL preview. This is a
 * deliberate boundary, not an unfinished one: prompt-injected text that reaches
 * the model must not be able to reach an UPDATE.
 *
 * ## Raw definitions, on purpose
 *
 * First-party DSH tools import `defineTool` from `@deepseek-ai/dsh-tools`, which
 * compiles an author-facing DSL into raw JSON Schema and validates arguments for
 * you. This plugin ships as plain ESM with no build step and that package is not
 * resolvable from a profile's `node_modules`, so these are raw `ToolDefinition`
 * objects: `parameters` and `output.schema` are already the compiled JSON Schema
 * shape, and — the part that matters — a raw definition owns its own input
 * validation. `checkArgs` below is that obligation, not boilerplate.
 *
 * Model-facing text is English because that is what the model reads and what the
 * rest of the DSH tool ecosystem uses; failures stay Chinese, matching the
 * layers underneath and the tool card the user actually looks at.
 */
import { assertReadOnly, listColumns, listDatabases, listTables, runReadOnlyQuery } from './db.js'

/**
 * Row cap when the model does not ask for one.
 *
 * Much smaller than the grid's 200: every row here is spent from the context
 * window, and a model that wants more can say so.
 */
const DEFAULT_ROW_LIMIT = 50

/** Row cap for one call, whatever the model asks for. */
const MAX_ROW_LIMIT = 500

/** A JSON scalar, which is all `toScalar` ever produces for a cell. */
const SCALAR = { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }

/** A string that the catalog reports as absent for some rows. */
const NULLABLE_STRING = { oneOf: [{ type: 'string' }, { type: 'null' }] }

/** A number that the catalog reports as absent for some rows. */
const NULLABLE_NUMBER = { oneOf: [{ type: 'number' }, { type: 'null' }] }

/**
 * Reject anything that is not a plain arguments object.
 *
 * The registry hands `execute` a frozen lossless-JSON snapshot of what the model
 * emitted, which means it can be any JSON value at all — including `null` or an
 * array. Everything below indexes into it, so this runs first.
 *
 * @param args - whatever the model sent.
 * @returns the same value, narrowed to a record.
 */
function checkArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('参数必须是一个对象')
  }
  return args
}

/**
 * A required non-empty string argument.
 *
 * The declared schema already says `type: 'string'`, but a raw definition is not
 * validated for us, and "declared required" is not the same as "not empty".
 *
 * @param args - the arguments record.
 * @param key - the parameter name.
 * @returns the trimmed value.
 */
function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${key}`)
  return value.trim()
}

/**
 * An optional string argument, absent when omitted, null, or blank.
 *
 * Blank counts as absent because `mysql_schema` switches on presence: a model
 * that fills `table: ''` means "no table", not "a table with an empty name".
 *
 * @param args - the arguments record.
 * @param key - the parameter name.
 * @returns the trimmed value, or `undefined`.
 */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The row cap for one call: clamped rather than refused.
 *
 * A model that asks for 100000 rows wants "a lot", and failing the call teaches
 * it nothing it can act on. The response reports what it actually got.
 *
 * @param args - the arguments record.
 * @param key - the parameter name.
 * @returns a row count within the tool's own bounds.
 */
function optionalLimit(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return DEFAULT_ROW_LIMIT
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`参数 ${key} 必须是数字`)
  return Math.min(Math.max(Math.trunc(value), 1), MAX_ROW_LIMIT)
}

/**
 * Resolve what the model called the connection to a stored profile.
 *
 * Accepts the id or the display name, because the model reads both from
 * `mysql_connections` and there is no reason to make it care which one is the
 * key. An unknown reference reports the ids and names that DO exist: the model's
 * next call should be able to succeed without a round trip through the user.
 *
 * @param store - the connection profile store.
 * @param ref - the id or name the model supplied.
 * @returns the stored profile, secrets included — it is about to connect.
 */
async function resolveConnection(store, ref) {
  const profiles = await store.list()
  const byId = profiles.find(profile => profile.id === ref)
  if (byId !== undefined) return byId
  const folded = ref.toLowerCase()
  const byName = profiles.filter(profile => String(profile.name ?? '').toLowerCase() === folded)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    throw new Error(`连接名 ${ref} 不唯一，请改用 id：${byName.map(profile => profile.id).join(', ')}`)
  }
  const known = profiles.map(profile => `${profile.id} (${profile.name ?? '未命名'})`).join('; ')
  throw new Error(known === ''
    ? '尚未配置任何 MySQL 连接，请先在 MySQL Studio 侧边栏里新建一个'
    : `未知的连接 ${ref}。可用连接：${known}`)
}

/**
 * The connection fields the model may see.
 *
 * An explicit allowlist rather than `publicProfile()`, for one reason: this is a
 * different trust boundary and it must not inherit future fields by accident.
 * `publicProfile` already replaces secrets with presence flags, but it is shaped
 * for a form that round-trips a profile; the model only needs to identify and
 * address a connection.
 *
 * @param profile - the stored profile.
 * @returns a secret-free description.
 */
function publicConnection(profile) {
  return {
    id: String(profile.id),
    name: String(profile.name ?? ''),
    host: String(profile.host ?? ''),
    port: Number(profile.port ?? 3306),
    user: String(profile.user ?? ''),
    database: profile.database === undefined || profile.database === '' ? null : String(profile.database),
  }
}

/** Cancellation is cooperative; the driver takes no signal, so check at the door. */
function checkAborted(exec) {
  if (exec?.signal?.aborted === true) throw new Error('调用已取消')
}

/**
 * Render one result set as JSON lines.
 *
 * A padded ASCII table reads well to a human and costs the model tokens for
 * whitespace it cannot use. JSON rows are compact and — the reason this is not
 * merely a style choice — unambiguous: a value containing a comma, a pipe, a
 * newline, or the literal text `NULL` survives, so the model never has to guess
 * whether a cell was empty or absent.
 *
 * @param value - the canonical result value.
 * @returns model-facing text.
 */
function renderRows(value) {
  const span = value.rowCount === 0
    ? 'no rows'
    : `${value.rowCount} row${value.rowCount === 1 ? '' : 's'}`
  const parts = [`${span} in ${value.elapsedMs}ms`]
  if (value.truncated) {
    parts.push('the result set is larger than this call\'s row cap — narrow the query or aggregate in SQL')
  }
  const head = parts.join('; ')
  if (value.columns.length === 0) {
    return value.affectedRows === null ? head : `${head}\naffectedRows: ${value.affectedRows}`
  }
  const lines = [head, `columns: ${value.columns.map(column => column.name).join(', ')}`]
  for (const row of value.rows) lines.push(JSON.stringify(row))
  return lines.join('\n')
}

/**
 * Build the three tool definitions.
 *
 * Kept separate from registration so tests can hold the definitions, inspect
 * their schemas, and drive `execute` directly without mounting a Cordis context.
 *
 * @param deps - the same store and pool registry the HTTP API uses.
 * @returns registry-ready raw tool definitions.
 */
export function createModelTools({ store, registry }) {
  /** Resolve a reference to a live pool. Called only after arguments validate. */
  const poolFor = async (reference) => {
    const profile = await resolveConnection(store, reference)
    return { profile, pool: await registry.poolFor(profile) }
  }

  return [
    {
      name: 'mysql_connections',
      description: 'List the MySQL connections configured in DSH MySQL Studio. '
        + 'Call this first to learn which connections exist and how to address them: '
        + 'every other mysql_* tool takes a `connection` argument, which is the `id` or `name` reported here. '
        + 'Passwords are never returned.',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connections: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  host: { type: 'string' },
                  port: { type: 'number' },
                  user: { type: 'string' },
                  database: NULLABLE_STRING,
                },
                required: ['id', 'name', 'host', 'port', 'user', 'database'],
              },
            },
          },
          required: ['connections'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.connections.length === 0
            ? 'No MySQL connection is configured yet. Ask the user to add one in the MySQL Studio sidebar.'
            : value.connections
              .map(row => `${row.id} | ${row.name} | ${row.host}:${row.port} | user=${row.user}`
                + `${row.database === null ? '' : ` | default db=${row.database}`}`)
              .join('\n'),
        }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        checkArgs(args)
        checkAborted(exec)
        return { connections: (await store.list()).map(publicConnection) }
      },
    },

    {
      name: 'mysql_schema',
      description: 'Inspect the structure of a MySQL connection, one level at a time. '
        + 'Omit `database` to list schemas; pass `database` to list its tables and views; '
        + 'pass `database` and `table` to describe that table\'s columns (type, nullability, key, default, comment). '
        + 'Use this before writing SQL instead of guessing table or column names.',
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'Connection id or name from mysql_connections.' },
          database: { type: 'string', description: 'Schema name. Omit to list the schemas this account can see.' },
          table: { type: 'string', description: 'Table or view name. Requires `database`. Omit to list the relations of `database`.' },
        },
        required: ['connection'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['schemas', 'tables', 'columns'] },
            connection: { type: 'string' },
            database: NULLABLE_STRING,
            table: NULLABLE_STRING,
            schemas: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string' }, system: { type: 'boolean' } },
                required: ['name', 'system'],
              },
            },
            tables: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  type: NULLABLE_STRING,
                  engine: NULLABLE_STRING,
                  estimatedRows: NULLABLE_NUMBER,
                  comment: NULLABLE_STRING,
                },
                required: ['name', 'type', 'engine', 'estimatedRows', 'comment'],
              },
            },
            columns: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  columnType: NULLABLE_STRING,
                  nullable: { type: 'boolean' },
                  columnKey: NULLABLE_STRING,
                  columnDefault: NULLABLE_STRING,
                  extra: NULLABLE_STRING,
                  comment: NULLABLE_STRING,
                },
                required: ['name', 'columnType', 'nullable', 'columnKey', 'columnDefault', 'extra', 'comment'],
              },
            },
          },
          required: ['kind', 'connection', 'database', 'table'],
        },
        render: (_args, value) => {
          if (value.kind === 'schemas') {
            const names = value.schemas.filter(row => !row.system).map(row => row.name)
            const system = value.schemas.filter(row => row.system).map(row => row.name)
            return [{
              type: 'text',
              text: `schemas: ${names.join(', ') || '(none)'}`
                + (system.length === 0 ? '' : `\nsystem schemas: ${system.join(', ')}`),
            }]
          }
          if (value.kind === 'tables') {
            return [{
              type: 'text',
              text: value.tables.length === 0
                ? `${value.database} has no tables or views`
                : value.tables
                  .map(row => `${row.name} | ${row.type ?? 'TABLE'}`
                    + `${row.estimatedRows === null ? '' : ` | ~${row.estimatedRows} rows`}`
                    + `${row.comment === null ? '' : ` | ${row.comment}`}`)
                  .join('\n'),
            }]
          }
          return [{
            type: 'text',
            text: value.columns.length === 0
              ? `${value.database}.${value.table} does not exist or has no columns`
              : value.columns
                .map(row => `${row.name} | ${row.columnType ?? 'unknown'}`
                  + ` | ${row.nullable ? 'NULL' : 'NOT NULL'}`
                  + `${row.columnKey === null ? '' : ` | key=${row.columnKey}`}`
                  + `${row.columnDefault === null ? '' : ` | default=${row.columnDefault}`}`
                  + `${row.extra === null ? '' : ` | ${row.extra}`}`
                  + `${row.comment === null ? '' : ` | ${row.comment}`}`)
                .join('\n'),
          }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const record = checkArgs(args)
        checkAborted(exec)
        // Every argument is validated before anything connects, so a malformed
        // call never costs a handshake.
        const reference = requireString(record, 'connection')
        const database = optionalString(record, 'database')
        const table = optionalString(record, 'table')
        if (table !== undefined && database === undefined) {
          throw new Error('查看表结构需要同时给出 database')
        }

        const { profile, pool } = await poolFor(reference)
        const base = { connection: profile.id, database: database ?? null, table: table ?? null }
        if (database === undefined) {
          const schemas = await listDatabases(pool)
          return { ...base, kind: 'schemas', schemas: schemas.map(row => ({ name: row.name, system: row.system })) }
        }
        // The catalog envelopes are shaped for the grid and carry fields the model
        // has no use for (a table's collation, a column's numeric driver type).
        // Projecting explicitly is not tidiness: the declared output schema is
        // closed, so an undeclared field the grid gains later would turn every
        // call into an error result.
        if (table === undefined) {
          const tables = await listTables(pool, database)
          return {
            ...base,
            kind: 'tables',
            tables: tables.map(row => ({
              name: row.name,
              type: row.type,
              engine: row.engine,
              estimatedRows: row.estimatedRows,
              comment: row.comment,
            })),
          }
        }
        const columns = await listColumns(pool, database, table)
        return {
          ...base,
          kind: 'columns',
          columns: columns.map(row => ({
            name: row.name,
            columnType: row.columnType,
            nullable: row.nullable,
            columnKey: row.columnKey,
            columnDefault: row.columnDefault,
            extra: row.extra,
            comment: row.comment,
          })),
        }
      },
    },

    {
      name: 'mysql_query',
      description: 'Run one READ-ONLY SQL statement against a MySQL connection and return its rows. '
        + 'Only SELECT / SHOW / DESCRIBE / EXPLAIN / WITH are accepted, one statement per call: '
        + 'writes, DDL, locking reads, and INTO OUTFILE are refused. '
        + 'There is no tool that writes — the user commits edits through the MySQL Studio grid, where a SQL preview is confirmed first. '
        + `One call returns at most ${MAX_ROW_LIMIT} rows (default ${DEFAULT_ROW_LIMIT}). `
        + 'A larger result set reports `truncated`: narrow the query or aggregate in SQL instead of paging.',
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'Connection id or name from mysql_connections.' },
          sql: { type: 'string', description: 'One read-only statement, without a trailing semicolon.' },
          database: { type: 'string', description: 'Schema to run in, so the statement can use unqualified table names.' },
          limit: { type: 'integer', description: `Maximum rows to return (1-${MAX_ROW_LIMIT}, default ${DEFAULT_ROW_LIMIT}). Values above the cap are clamped, not refused.` },
        },
        required: ['connection', 'sql'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            connection: { type: 'string' },
            database: NULLABLE_STRING,
            columns: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string' }, type: { type: 'string' }, nullable: { type: 'boolean' } },
                required: ['name', 'type', 'nullable'],
              },
            },
            rows: { type: 'array', items: { type: 'array', items: SCALAR } },
            rowCount: { type: 'integer', description: 'Rows in this response.' },
            truncated: {
              type: 'boolean',
              description: 'The result set is larger than this call\'s row cap; rows beyond it were not returned.',
            },
            elapsedMs: { type: 'integer', description: 'How long the statement took.' },
            affectedRows: NULLABLE_NUMBER,
          },
          required: [
            'connection', 'database', 'columns', 'rows', 'rowCount',
            'truncated', 'elapsedMs', 'affectedRows',
          ],
        },
        render: (_args, value) => [{ type: 'text', text: renderRows(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const record = checkArgs(args)
        checkAborted(exec)
        const reference = requireString(record, 'connection')
        const sql = requireString(record, 'sql')
        const database = optionalString(record, 'database')
        const limit = optionalLimit(record, 'limit')

        // Screened BEFORE anything connects. `runReadOnlyQuery` remains the
        // authority — this is not the only gate and must never become it — but a
        // statement it will refuse should not first cost a pooled connection.
        // The model-facing surface is where prompt-injected writes arrive, so it
        // is worth refusing them at the door.
        assertReadOnly(sql)

        const { profile, pool } = await poolFor(reference)
        const result = await runReadOnlyQuery(pool, { sql, database, limit })
        const columns = result.columns.map(column => ({
          name: String(column.name),
          type: String(column.type ?? 'unknown'),
          nullable: column.nullable !== false,
        }))

        return {
          connection: profile.id,
          database: database ?? null,
          columns,
          rows: result.rows,
          rowCount: result.rows.length,
          truncated: result.truncated === true,
          elapsedMs: result.elapsedMs,
          affectedRows: columns.length === 0 ? (result.affectedRows ?? null) : null,
        }
      },
    },
  ]
}

/**
 * Register the tools, when a tool registry is actually mounted.
 *
 * `tools` is resolved through `ctx.inject` rather than the plugin's own `inject`
 * list on purpose: a profile composed without `dsh-tools` would otherwise never
 * load this plugin at all, and the workbench — the half the user opens — does
 * not need the registry. The agent surface is an enhancement; it must not be a
 * load-bearing dependency of the UI.
 *
 * Because the dependency is optional, "no tools" is a legitimate state rather
 * than a failure — and therefore an invisible one. The returned status is
 * reported by the `health` method so a deployed process can be asked whether the
 * agent surface actually came up, instead of it being inferred from the fact that
 * the sidebar works.
 *
 * @param ctx - the host plugin context.
 * @param deps - the store and pool registry shared with the HTTP API.
 * @returns live registration status: the registry's presence and the tool names.
 */
export function registerModelTools(ctx, deps) {
  const status = { registryMounted: false, tools: [] }
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(() => {
      const definitions = createModelTools(deps)
      const disposers = definitions.map(definition => toolsCtx.tools.register(definition))
      status.registryMounted = true
      // Parameter names, not just tool names. A name list cannot tell one
      // generation of this surface from the next, and "restarted but the code did
      // not change" is the trap this project keeps falling into: the deployed
      // parameters are the cheapest thing that actually distinguishes them.
      status.tools = definitions.map(definition => ({
        name: definition.name,
        parameters: Object.keys(definition.parameters.properties ?? {}),
      }))
      return () => {
        for (const dispose of disposers) dispose()
        status.registryMounted = false
        status.tools = []
      }
    }, 'dsh-mysql-studio: model tools')
  })
  return status
}
