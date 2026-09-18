/**
 * dsh-mysql-studio — the MySQL data layer.
 *
 * Owns three concerns and nothing else:
 *
 * 1. **Reaching mysql2.** A profile-installed plugin lives behind a `link:`, so
 *    a bare `require('mysql2/promise')` from its own directory may not resolve.
 *    {@link loadMysql} tries the plugin's own dependency tree first (the honest
 *    case, when the package was installed with its dependencies) and then the
 *    DSH profile that hosts it — which is where mysql2 already lives whenever
 *    `dsh-sql` is installed.
 * 2. **Pooling.** One mysql2 pool per connection profile, rebuilt when the
 *    profile's revision changes, torn down with the plugin.
 * 3. **Reading and guarded writing.** Catalog introspection, paged table reads,
 *    a lexical read-only gate for the model tools, and a separate confirmed-write
 *    path for the SQL console (preview the exact statement, then execute it).
 *
 * Every value that leaves this module is JSON-scalar: see {@link toScalar}.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connectionOptions, dshHome, isSafeIdentifier, quoteId, quoteTable } from './store.js'

/** How long a single statement may run before its dedicated connection is destroyed. */
const DEFAULT_STATEMENT_TIMEOUT_MS = 30000
/** The most rows any single read may fetch. */
export const MAX_PAGE_SIZE = 2000
const DEFAULT_PAGE_SIZE = 200

let mysqlModule

/**
 * Load mysql2.
 *
 * The plugin's OWN dependency tree is the contract: a plugin that needs a driver
 * carries it, so the first anchor is the one that must succeed. The profile
 * anchors below are a convenience fallback (for a source checkout whose
 * dependencies were installed by the hosting profile instead), and they are NOT
 * a guarantee — this project once leaned on them and broke when the profile's
 * mysql2, which belonged to an unrelated plugin, was removed underneath it.
 *
 * @returns the `mysql2/promise` module namespace.
 * @throws when no candidate anchor can resolve it, naming every anchor tried.
 */
export function loadMysql() {
  if (mysqlModule !== undefined) return mysqlModule
  const profileAnchor = base => pathToFileURL(join(base, 'profiles', 'web', 'package.json')).href
  const anchors = [
    // 1. The plugin's own tree — the real contract, provided by running
    //    `pnpm install` in this directory.
    import.meta.url,
    // 2. The hosting profile (the configured home, then the real user home).
    profileAnchor(dshHome()),
    profileAnchor(join(homedir(), '.dsh')),
  ]
  const tried = []
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      mysqlModule = require('mysql2/promise')
      return mysqlModule
    } catch (error) {
      tried.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    '无法加载 mysql2：请在本插件目录执行 `pnpm install`——插件必须自带数据库驱动，不能依赖别的插件的依赖树。已尝试：\n'
    + tried.join('\n'),
  )
}

/**
 * Turn one driver value into a JSON scalar.
 *
 * The grid is driven by the column's declared type, so every cell can be a
 * scalar without losing information: binary data becomes base64 (the client
 * decodes it for the hex preview and byte count), a structured JSON column is
 * re-serialized, and a bigint stays the string mysql2 already produced for an
 * out-of-range value.
 *
 * @param value - what the driver returned.
 * @returns a JSON-safe scalar.
 */
export function toScalar(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Array.isArray(value) || typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/** Map a result row (object or array form) to an array of scalars in column order. */
function toRow(row, columns) {
  if (Array.isArray(row)) return row.map(toScalar)
  const fields = columns ?? Object.keys(row)
  return fields.map(field => toScalar(row[field]))
}

/** The column descriptors a grid needs: name, declared type, and nullability. */
function toColumns(fields) {
  if (fields === undefined || fields === null) return []
  return fields.map(field => ({
    name: field.name,
    type: field.type === undefined ? 'unknown' : String(field.type),
    dataType: typeof field.columnType === 'number' ? field.columnType : undefined,
    nullable: field.flags === undefined ? true : (field.flags & 1) === 1,
  }))
}

/**
 * Resolve a profile's TLS material: a value that names a readable file is read,
 * anything else is treated as PEM text already pasted into the form.
 *
 * @param profile - the stored profile.
 * @returns the CA PEM text, or `undefined`.
 */
async function resolveSslMaterial(profile) {
  const ssl = profile.ssl
  if (ssl === undefined || ssl.mode === 'disabled') return undefined
  const ca = ssl.ca
  if (ca === undefined) return undefined
  if (ca.includes('-----BEGIN')) return ca
  const candidate = isAbsolute(ca) ? ca : join(dshHome(), ca)
  try {
    return await readFile(candidate, 'utf8')
  } catch {
    // Not a readable path: hand it to the driver as-is so the failure names the
    // certificate rather than this lookup.
    return ca
  }
}

/** The offset just past the balanced group that starts at `start`, or `-1`. */
function skipBalancedGroup(text, start) {
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * Where a `WITH …` statement's main statement begins.
 *
 * Each CTE has the shape `name [(columns)] AS ( body )`, and a naive paren walk
 * mis-reads the optional COLUMN LIST as the body — which is how
 * `WITH RECURSIVE t(n) AS (…) SELECT …`, an ordinary read, first got refused.
 * So the clauses are consumed in order: name, optional column list, `AS`, body.
 *
 * Anything unrecognised returns `-1`, and the caller fails closed: guessing here
 * is exactly how a write gets through.
 *
 * @param text - the stripped statement.
 * @param start - offset of the first CTE name.
 * @returns the offset of the main statement, or `-1` when the shape is unclear.
 */
function cteMainStatementOffset(text, start) {
  let i = start
  for (;;) {
    // A CTE after the first begins just past a comma, i.e. on whitespace.
    while (i < text.length && /\s/.test(text[i])) i += 1
    const nameStart = i
    while (i < text.length && /[A-Za-z0-9_$.]/.test(text[i])) i += 1
    if (i === nameStart) return -1

    let j = i
    while (j < text.length && /\s/.test(text[j])) j += 1
    // The optional column list, which only exists when '(' comes before AS.
    if (text[j] === '(') {
      const afterColumns = skipBalancedGroup(text, j)
      if (afterColumns === -1) return -1
      j = afterColumns
      while (j < text.length && /\s/.test(text[j])) j += 1
    }

    if (!/^AS\b/i.test(text.slice(j))) return -1
    j += 2
    while (j < text.length && /\s/.test(text[j])) j += 1
    if (text[j] !== '(') return -1
    const afterBody = skipBalancedGroup(text, j)
    if (afterBody === -1) return -1

    let k = afterBody
    while (k < text.length && /\s/.test(text[k])) k += 1
    if (text[k] === ',') {
      i = k + 1
      continue
    }
    return k
  }
}

/**
 * A decision copy of a statement: comments gone, string literals blanked, so a
 * keyword inside either cannot vote. `stripped` is only ever used to decide;
 * `executable` is the caller's own text (trailing terminator dropped), because
 * running the stripped form would blank every literal (`WHERE name = 'bob'`
 * would run as `WHERE name = ''`).
 *
 * @param sql - the caller's statement.
 * @returns `{ original, executable, stripped }`.
 */
export function inspectSql(sql) {
  const original = String(sql).trim()
  const stripped = original
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"\\]|\\.|"")*"/g, '""')
    .trim()
    .replace(/;+\s*$/, '')
  return { original, executable: original.replace(/;+\s*$/, ''), stripped }
}

/** Refuse statements that write to the server's filesystem, even with confirm. */
function assertNoFilesystemSql(stripped) {
  if (/\binto\s+(outfile|dumpfile)\b/i.test(stripped)) {
    throw new Error('不允许 SELECT ... INTO OUTFILE/DUMPFILE')
  }
  if (/\bload\s+data\b/i.test(stripped)) throw new Error('不允许 LOAD DATA')
}

/**
 * One statement, comments and literals aside, or throw.
 *
 * @param sql - the caller's text.
 * @returns the executable statement (trailing terminator dropped).
 */
export function assertSingleStatement(sql) {
  const { executable, stripped } = inspectSql(sql)
  if (stripped === '') throw new Error('SQL 不能为空')
  if (stripped.includes(';')) throw new Error('一次只能执行一条语句')
  assertNoFilesystemSql(stripped)
  return executable
}

/**
 * The read-only statement guard.
 *
 * Comments and string literals are stripped to DECIDE the verdict, so a keyword
 * inside either cannot vote. The stripped text is only ever a decision copy: the
 * statement that gets executed is the caller's own, because executing the
 * stripped form would blank every literal in it (`WHERE name = 'bob'` would run
 * as `WHERE name = ''`).
 *
 * Two ways of hiding a write behind a reading verb are handled explicitly,
 * because both were once let through:
 *
 * - **A data-modifying CTE.** `WITH … DELETE` / `UPDATE` / `INSERT` is valid
 *   MySQL 8 and starts with WITH, so a prefix check sees a read. The main
 *   statement after the CTE list is what decides.
 * - **`EXPLAIN ANALYZE`.** Unlike plain `EXPLAIN`, it EXECUTES the statement it
 *   analyses, so it is held to the same standard as the statement itself.
 *
 * @param sql - the caller's statement.
 * @returns the caller's statement with any trailing terminator removed.
 * @throws when the statement is not a plain read.
 */
export function assertReadOnly(sql) {
  const { executable, stripped } = inspectSql(sql)

  if (stripped === '') throw new Error('SQL 不能为空')
  // A statement separator outside a literal means more than one statement.
  if (stripped.includes(';')) throw new Error('一次只能执行一条语句')
  if (!/^(select|show|describe|desc|explain|with)\b/i.test(stripped)) {
    throw new Error('当前版本只允许只读语句（SELECT / SHOW / DESCRIBE / EXPLAIN / WITH）')
  }
  assertNoFilesystemSql(stripped)
  if (/\bfor\s+(update|share)\b/i.test(stripped)) throw new Error('不允许 FOR UPDATE / FOR SHARE 加锁读')
  if (/\block\s+in\s+share\s+mode\b/i.test(stripped)) throw new Error('不允许 LOCK IN SHARE MODE')

  // The statement that will ACTUALLY run: `EXPLAIN ANALYZE x` runs x, so x is
  // what has to be a read. Plain `EXPLAIN` only plans, and needs no such check.
  let effective = stripped
  const explain = /^EXPLAIN\s+/i.exec(stripped)
  if (explain !== null) {
    const rest = stripped.slice(explain[0].length)
    if (/^ANALYZE\b/i.test(rest)) {
      effective = rest.replace(/^ANALYZE\s+/i, '').trim()
      if (!/^(select|with)\b/i.test(effective)) {
        throw new Error('EXPLAIN ANALYZE 会真正执行被分析的语句，因此只允许分析 SELECT / WITH')
      }
    }
  }

  if (/^WITH\b/i.test(effective)) {
    const head = /^WITH\s+(?:RECURSIVE\s+)?/i.exec(effective)
    const offset = cteMainStatementOffset(effective, head === null ? 4 : head[0].length)
    const main = offset === -1 ? '' : effective.slice(offset).trim()
    if (!/^SELECT\b/i.test(main)) {
      throw new Error('WITH 之后只能是 SELECT：不允许 data-modifying CTE（WITH … DELETE / UPDATE / INSERT）')
    }
  }

  // Only a trailing terminator is dropped; everything else is the caller's text.
  return executable
}

/**
 * Pool registry: one pool per connection id, keyed by the profile revision so a
 * saved edit transparently rebuilds it.
 */
export class PoolRegistry {
  constructor() {
    /** @type {Map<string, { pool: unknown, revision: string }>} */
    this.pools = new Map()
  }

  /**
   * The pool for one profile, creating or rebuilding it as needed.
   * @param profile - the stored profile.
   * @returns the mysql2 pool.
   */
  async poolFor(profile) {
    const revision = [
      profile.updatedAt ?? '',
      profile.host ?? '',
      profile.port ?? '',
      profile.user,
      profile.ssl?.mode ?? 'disabled',
    ].join('|')
    const cached = this.pools.get(profile.id)
    if (cached !== undefined && cached.revision === revision) return cached.pool

    if (cached !== undefined) await this.close(profile.id)

    const mysql = loadMysql()
    const ca = await resolveSslMaterial(profile)
    const pool = mysql.createPool({
      ...connectionOptions(profile, ca),
      waitForConnections: true,
      connectionLimit: 4,
      maxIdle: 2,
      idleTimeout: 60000,
      enableKeepAlive: true,
    })
    this.pools.set(profile.id, { pool, revision })
    return pool
  }

  /**
   * Close one connection's pool.
   * @param id - the connection id.
   */
  async close(id) {
    const cached = this.pools.get(id)
    if (cached === undefined) return
    this.pools.delete(id)
    try {
      await cached.pool.end()
    } catch {
      // A pool whose sockets are already gone has nothing left to release.
    }
  }

  /** Close every pool; called when the plugin unloads. */
  async closeAll() {
    for (const id of [...this.pools.keys()]) await this.close(id)
  }
}

/**
 * Run one callback on a dedicated pooled connection, optionally selecting a
 * database first.
 *
 * `USE` is per-connection, so it is only safe while the same connection is held
 * for the statement that follows — which is exactly what this does, and why the
 * read path does not simply set a default schema on the pool.
 *
 * @param pool - the connection's pool.
 * @param database - a validated database name to select, or `undefined`.
 * @param run - the work, receiving the connection.
 * @returns whatever `run` returned.
 */
async function withConnection(pool, database, run) {
  const connection = await pool.getConnection()
  try {
    if (database !== undefined) {
      if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
      await connection.query('USE ' + quoteId(database))
    }
    return await run(connection)
  } finally {
    connection.release()
  }
}

/** The result envelope every read returns. */
function readResult(rows, fields) {
  return {
    columns: toColumns(fields),
    rows: rows.map(row => toRow(row, fields?.map?.(field => field.name))),
    rowCount: rows.length,
  }
}

/**
 * Probe one profile: open a single connection, read the server's identity, close.
 *
 * @param profile - the stored profile.
 * @returns the server's version, current user, and round-trip latency.
 */
export async function testProfile(profile) {
  const mysql = loadMysql()
  const ca = await resolveSslMaterial(profile)
  const startedAt = Date.now()
  let connection
  try {
    connection = await mysql.createConnection(connectionOptions(profile, ca))
    const [rows] = await connection.query(
      'SELECT VERSION() AS version, CURRENT_USER() AS currentUser, DATABASE() AS currentDatabase, @@character_set_server AS serverCharset, @@lower_case_table_names AS lowerCaseTableNames',
    )
    const info = rows[0] ?? {}
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      version: info.version ?? null,
      currentUser: info.currentUser ?? null,
      currentDatabase: info.currentDatabase ?? null,
      serverCharset: info.serverCharset ?? null,
      lowerCaseTableNames: info.lowerCaseTableNames ?? null,
    }
  } finally {
    if (connection !== undefined) {
      try {
        await connection.end()
      } catch {
        // Nothing to release when the handshake itself failed.
      }
    }
  }
}

/**
 * The databases the connected account can see.
 * @param pool - the connection's pool.
 * @returns one entry per schema, system schemas flagged.
 */
export async function listDatabases(pool) {
  const [rows] = await pool.query(
    'SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation '
    + 'FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME',
  )
  const system = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])
  return rows.map(row => ({
    name: String(row.name),
    charset: row.charset === null ? null : String(row.charset),
    collation: row.collation === null ? null : String(row.collation),
    system: system.has(String(row.name)),
  }))
}

/**
 * The tables and views of one schema.
 * @param pool - the connection's pool.
 * @param database - the schema name.
 * @returns one entry per relation.
 */
export async function listTables(pool, database) {
  if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
  const [rows] = await pool.query(
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS estimatedRows, '
    + 'TABLE_COMMENT AS comment, TABLE_COLLATION AS collation '
    + 'FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [database],
  )
  return rows.map(row => ({
    name: String(row.name),
    type: row.type === null ? null : String(row.type),
    engine: row.engine === null ? null : String(row.engine),
    estimatedRows: row.estimatedRows === null || row.estimatedRows === undefined ? null : Number(row.estimatedRows),
    comment: row.comment === null || row.comment === '' ? null : String(row.comment),
    collation: row.collation === null ? null : String(row.collation),
  }))
}

/**
 * One table's columns.
 * @param pool - the connection's pool.
 * @param database - the schema name.
 * @param table - the table name.
 * @returns one entry per column, in ordinal order.
 */
export async function listColumns(pool, database, table) {
  if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
  if (!isSafeIdentifier(table)) throw new Error(`非法的表名：${table}`)
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS columnType, DATA_TYPE AS dataType, IS_NULLABLE AS nullable, '
    + 'COLUMN_KEY AS columnKey, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra, COLUMN_COMMENT AS comment '
    + 'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table],
  )
  return rows.map(row => ({
    name: String(row.name),
    columnType: row.columnType === null ? null : String(row.columnType),
    dataType: row.dataType === null ? null : String(row.dataType),
    nullable: row.nullable === 'YES',
    columnKey: row.columnKey === null || row.columnKey === '' ? null : String(row.columnKey),
    columnDefault: row.columnDefault === null || row.columnDefault === undefined ? null : String(row.columnDefault),
    extra: row.extra === null || row.extra === '' ? null : String(row.extra),
    comment: row.comment === null || row.comment === '' ? null : String(row.comment),
  }))
}

/**
 * The primary-key column names of one table.
 *
 * A grid that will later commit edits needs a stable row identity; the skeleton
 * already reads it so the data response carries the same information the
 * editing iteration will act on.
 *
 * @param pool - the connection's pool.
 * @param database - the schema name.
 * @param table - the table name.
 * @returns the key columns, in index order; empty for a keyless table.
 */
export async function primaryKeyOf(pool, database, table) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE '
    + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table, 'PRIMARY'],
  )
  return rows.map(row => String(row.name))
}

/**
 * One page of a table's rows.
 *
 * The ordering falls back to the primary key so that paging is stable; a
 * keyless table is read in the server's own order, which is why the response
 * says whether the page can be trusted to repeat.
 *
 * @param pool - the connection's pool.
 * @param request - database, table, page size, offset, and an optional order clause.
 * @returns the page plus the metadata a grid needs to render it.
 */
export async function fetchRows(pool, request) {
  const { database, table } = request
  if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
  if (!isSafeIdentifier(table)) throw new Error(`非法的表名：${table}`)

  const limit = Math.min(Math.max(Number(request.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const offset = Math.max(Number(request.offset) || 0, 0)

  const primaryKey = await primaryKeyOf(pool, database, table)
  let orderClause = ''
  if (primaryKey.length > 0) {
    orderClause = ' ORDER BY ' + primaryKey.map(column => quoteId(column)).join(', ')
  }

  // One extra row answers "is there more?" without a second COUNT, which on a
  // large table is the expensive half of paging.
  const [rows, fields] = await pool.query({
    sql: `SELECT * FROM ${quoteTable(database, table)}${orderClause} LIMIT ? OFFSET ?`,
    values: [limit + 1, offset],
    timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  return {
    ...readResult(page, fields),
    database,
    table,
    limit,
    offset,
    hasMore,
    primaryKey,
  }
}

/**
 * Run one guarded read-only statement.
 *
 * @param pool - the connection's pool.
 * @param request - the statement, an optional default schema, and a row cap.
 * @returns the result set, or the affected-row count for a statement with none.
 */
export async function runReadOnlyQuery(pool, request) {
  const stripped = assertReadOnly(request.sql)
  const limit = Math.min(Math.max(Number(request.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const database = request.database === undefined || request.database === '' ? undefined : request.database
  if (database !== undefined && !isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)

  const startedAt = Date.now()
  return withConnection(pool, database, async (connection) => {
    const [rows, fields] = await connection.query({
      sql: stripped,
      timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
    })
    const elapsedMs = Date.now() - startedAt
    // A write-ish statement smuggled past the guard still cannot return a result
    // set; reporting the count keeps the response honest either way.
    if (!Array.isArray(rows)) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        elapsedMs,
        affectedRows: rows?.affectedRows ?? null,
        info: rows?.info ?? null,
      }
    }
    const truncated = rows.length > limit
    const page = truncated ? rows.slice(0, limit) : rows
    return { ...readResult(page, fields), elapsedMs, truncated }
  })
}

/**
 * Whether `sql` is a plain read under {@link assertReadOnly}.
 *
 * Structural failures (empty, multi-statement, filesystem writes) still throw:
 * those are never a previewable write.
 *
 * @param sql - a single statement.
 * @returns `true` when the statement may run without confirmation.
 */
export function isReadStatement(sql) {
  try {
    assertReadOnly(sql)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/不能为空|一条语句|OUTFILE|DUMPFILE|LOAD DATA/.test(message)) throw error
    return false
  }
}

/**
 * The SQL console's execution path: a read runs immediately; a write is returned
 * as a preview unless `confirmSql` is the exact statement that was previewed.
 *
 * Confirmation is by exact string match, so editing the box between preview and
 * confirm cannot smuggle a different statement through.
 *
 * @param pool - the connection's pool.
 * @param request - sql, optional default schema, row cap, dryRun, confirmSql.
 */
export async function runQuery(pool, request) {
  const sql = assertSingleStatement(request.sql)
  if (isReadStatement(sql)) {
    return { kind: 'read', sql, ...(await runReadOnlyQuery(pool, { ...request, sql })) }
  }
  if (request.dryRun === true || request.confirmSql !== sql) {
    return { kind: 'write', sql, needsConfirm: true, dryRun: true }
  }
  return executeStatement(pool, { sql, database: request.database, limit: request.limit, kind: 'write' })
}

/**
 * Run one already-validated statement and shape the driver result for the grid.
 *
 * @param pool - the connection's pool.
 * @param request - executable sql, optional schema, row cap, and result kind.
 */
async function executeStatement(pool, request) {
  const limit = Math.min(Math.max(Number(request.limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  const database = request.database === undefined || request.database === '' ? undefined : request.database
  if (database !== undefined && !isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
  const startedAt = Date.now()
  return withConnection(pool, database, async (connection) => {
    const [rows, fields] = await connection.query({
      sql: request.sql,
      timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
    })
    const elapsedMs = Date.now() - startedAt
    if (!Array.isArray(rows)) {
      return {
        kind: request.kind ?? 'write',
        sql: request.sql,
        columns: [],
        rows: [],
        rowCount: 0,
        elapsedMs,
        affectedRows: rows?.affectedRows ?? 0,
        insertId: rows?.insertId ?? null,
        info: rows?.info ?? null,
        warningStatus: rows?.warningStatus ?? 0,
      }
    }
    const truncated = rows.length > limit
    const page = truncated ? rows.slice(0, limit) : rows
    return {
      kind: request.kind ?? 'write',
      sql: request.sql,
      ...readResult(page, fields),
      elapsedMs,
      truncated,
      affectedRows: null,
    }
  })
}

/** A charset / collation / engine name, or `undefined` when empty. */
function optionalIdent(value, label) {
  if (value === undefined || value === null) return undefined
  const name = String(value).trim()
  if (name === '') return undefined
  if (!isSafeIdentifier(name)) throw new Error(`非法的${label}：${name}`)
  return name
}

/**
 * A column type the form is allowed to interpolate.
 *
 * Restricted to a type name plus optional precision, UNSIGNED, and CHARSET /
 * COLLATE — no quotes, no nested parens, no default expressions. ENUM / SET
 * belong in the advanced-SQL tab.
 *
 * @param type - the form's type string.
 */
export function isSafeColumnType(type) {
  const text = String(type ?? '').trim()
  if (text === '' || text.length > 128) return false
  return /^(?:[A-Za-z][A-Za-z0-9]*(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+UNSIGNED)?(?:\s+ZEROFILL)?(?:\s+CHARACTER\s+SET\s+[A-Za-z0-9_]+)?(?:\s+COLLATE\s+[A-Za-z0-9_]+)?)$/i.test(text)
}

/**
 * `CREATE DATABASE` from the form fields.
 *
 * @param request - name, optional charset and collation.
 */
export function buildCreateDatabaseSql(request) {
  const name = String(request?.name ?? '').trim()
  if (!isSafeIdentifier(name)) throw new Error(`非法的库名：${name || '（空）'}`)
  let sql = `CREATE DATABASE ${quoteId(name)}`
  const charset = optionalIdent(request?.charset, '字符集')
  const collation = optionalIdent(request?.collation, '排序规则')
  if (charset !== undefined) sql += ` CHARACTER SET ${quoteId(charset)}`
  if (collation !== undefined) sql += ` COLLATE ${quoteId(collation)}`
  return sql
}

/**
 * `CREATE TABLE` from the form fields.
 *
 * @param request - database, name, columns, optional engine / charset / collation.
 */
export function buildCreateTableSql(request) {
  const database = String(request?.database ?? '').trim()
  const name = String(request?.name ?? '').trim()
  if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database || '（空）'}`)
  if (!isSafeIdentifier(name)) throw new Error(`非法的表名：${name || '（空）'}`)
  const columns = Array.isArray(request?.columns) ? request.columns : []
  if (columns.length === 0) throw new Error('至少定义一列')

  const pk = []
  const defs = columns.map((column, index) => {
    const columnName = String(column?.name ?? '').trim()
    if (!isSafeIdentifier(columnName)) throw new Error(`第 ${index + 1} 列名非法：${columnName || '（空）'}`)
    const type = String(column?.type ?? '').trim()
    if (!isSafeColumnType(type)) throw new Error(`第 ${index + 1} 列类型不受支持：${type || '（空）'}`)
    let def = `${quoteId(columnName)} ${type}`
    if (column?.nullable === false) def += ' NOT NULL'
    else def += ' NULL'
    if (column?.autoIncrement === true) {
      if (!/int/i.test(type)) throw new Error(`AUTO_INCREMENT 只能用在整数列（${columnName}）`)
      def += ' AUTO_INCREMENT'
    }
    if (column?.primaryKey === true) pk.push(columnName)
    return def
  })
  if (pk.length > 0) defs.push(`PRIMARY KEY (${pk.map(quoteId).join(', ')})`)

  let sql = `CREATE TABLE ${quoteTable(database, name)} (\n  ${defs.join(',\n  ')}\n)`
  const engine = optionalIdent(request?.engine, '引擎') ?? 'InnoDB'
  sql += ` ENGINE=${engine}`
  const charset = optionalIdent(request?.charset, '字符集')
  const collation = optionalIdent(request?.collation, '排序规则')
  if (charset !== undefined) sql += ` DEFAULT CHARSET=${charset}`
  if (collation !== undefined) sql += ` COLLATE=${collation}`
  return sql
}

/** Advanced SQL in the create-database dialog: CREATE DATABASE / SCHEMA only. */
export function assertCreateDatabaseSql(sql) {
  const executable = assertSingleStatement(sql)
  const { stripped } = inspectSql(executable)
  if (!/^CREATE\s+(DATABASE|SCHEMA)\b/i.test(stripped)) {
    throw new Error('高级 SQL 只允许 CREATE DATABASE / CREATE SCHEMA')
  }
  return executable
}

/** Advanced SQL in the create-table dialog: CREATE TABLE only. */
export function assertCreateTableSql(sql) {
  const executable = assertSingleStatement(sql)
  const { stripped } = inspectSql(executable)
  if (!/^CREATE\s+(TEMPORARY\s+)?TABLE\b/i.test(stripped)) {
    throw new Error('高级 SQL 只允许 CREATE TABLE')
  }
  return executable
}

/**
 * Preview or execute one DDL statement.
 *
 * Same confirm contract as {@link runQuery}: the statement that runs is the
 * one that was previewed, matched by exact string.
 *
 * @param pool - the connection's pool.
 * @param request - sql, optional default schema, dryRun, confirmSql.
 */
export async function runSchemaChange(pool, request) {
  const sql = assertSingleStatement(request.sql)
  if (request.dryRun === true || request.confirmSql !== sql) {
    return { kind: 'ddl', sql, needsConfirm: true, dryRun: true }
  }
  return executeStatement(pool, { sql, database: request.database, kind: 'ddl' })
}

/** Quote one cell as a MySQL literal for INSERT export. */
export function sqlLiteral(value, column) {
  if (value === null || value === undefined) return 'NULL'
  const type = String(column?.type || column?.columnType || column?.dataType || '')
  if (/blob|binary/i.test(type)) {
    const buf = Buffer.from(String(value), 'base64')
    return `X'${buf.toString('hex')}'`
  }
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (/^(?:tiny|small|medium|big)?int|decimal|float|double|numeric|bit|year/i.test(type)
    && value !== '' && Number.isFinite(Number(value))) {
    return String(value)
  }
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"
}

/**
 * Turn a result set into INSERT statements.
 *
 * @param request - optional database, table, columns, rows.
 * @returns a `.sql` document.
 */
export function formatInsertSql(request) {
  const columns = Array.isArray(request?.columns) ? request.columns : []
  const rows = Array.isArray(request?.rows) ? request.rows : []
  if (columns.length === 0) throw new Error('没有可导出的列')
  if (rows.length === 0) throw new Error('没有可导出的行')

  const table = String(request?.table ?? '').trim()
  const database = String(request?.database ?? '').trim()
  let target
  if (table !== '') {
    if (!isSafeIdentifier(table)) throw new Error(`非法的表名：${table}`)
    if (database !== '') {
      if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
      target = quoteTable(database, table)
    } else {
      target = quoteId(table)
    }
  } else {
    target = '`export`'
  }

  const names = columns.map((column, index) => {
    const name = String(column?.name ?? '').trim()
    if (name === '') throw new Error(`第 ${index + 1} 列没有名字`)
    return quoteId(name)
  })
  const values = rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new Error(`第 ${rowIndex + 1} 行的列数与表头不一致`)
    }
    return '(' + row.map((cell, cellIndex) => sqlLiteral(cell, columns[cellIndex])).join(', ') + ')'
  })
  const chunk = 100
  const parts = []
  for (let i = 0; i < values.length; i += chunk) {
    parts.push(`INSERT INTO ${target} (${names.join(', ')}) VALUES\n  ${values.slice(i, i + chunk).join(',\n  ')};`)
  }
  return parts.join('\n\n') + '\n'
}

// ── mutation (edit / insert / delete) ───────────────────────────────────────

/**
 * How much of the original row the WHERE clause insists on, i.e. how strictly a
 * commit detects that someone else changed the row first.
 *
 * - `pk` — only the primary key. Last write wins on every other column.
 * - `pk-changed` — the key plus the ORIGINAL value of each column being written,
 *   so a commit fails if any of the cells it is about to overwrite moved.
 *
 * A third mode used to sit here — `pk-row`, which put every other column's
 * original value in the WHERE clause. It was removed because its practical effect
 * was a high false-conflict rate: an unrelated writer touching any cell anywhere
 * in the row made the commit fail, and the reader's only recourse was to reload
 * and retype. `pk-changed` protects exactly the cells at risk, which is the
 * failure a grid actually needs to catch.
 */
export const CONCURRENCY_MODES = ['pk', 'pk-changed']

/** The default: strict enough to catch a lost update on the cells being written. */
export const DEFAULT_CONCURRENCY = 'pk-changed'

/** A mutation that matched no row — the row moved, or it is gone. */
export class MutationConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MutationConflictError'
    this.code = 'conflict'
  }
}

/** A plain object, or an empty one. */
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Whether a submitted value is the same as the one the grid loaded. */
function sameValue(submitted, loaded) {
  if (submitted === null || submitted === undefined) return loaded === null || loaded === undefined
  if (loaded === null || loaded === undefined) return false
  // The grid round-trips everything as text, so the comparison is by text: an
  // INT cell holding 7 and a submitted "7" are the same edit (no edit at all).
  return String(submitted) === String(loaded)
}

/**
 * Coerce a submitted cell into what the driver binds.
 *
 * The grid submits text; MySQL coerces a text parameter into the column's own
 * type, which keeps date/decimal/enum handling on the server where it belongs
 * instead of guessing at types in the browser.
 */
function bindValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  return String(value)
}

/** A column the grid is allowed to write, by name. */
function writableColumn(name, columnMap) {
  const column = columnMap.get(name)
  if (column === undefined) throw new Error(`表里没有列 ${name}`)
  if (/blob|binary/i.test(column.columnType ?? '')) {
    throw new Error(`二进制列 ${name} 不能在网格里编辑`)
  }
  if (/GENERATED/i.test(column.extra ?? '')) {
    throw new Error(`生成列 ${name} 不能写入`)
  }
  return column
}

/**
 * The WHERE operands that identify one row.
 *
 * `<=>` is MySQL's NULL-safe equality, which is what makes a NULL-valued key or
 * a NULL original comparable at all — `col = NULL` never matches anything.
 *
 * @param mode - the concurrency mode.
 * @param mutation - the submitted mutation (its `key` and `original`).
 * @param primaryKey - the table's primary-key columns.
 * @param changedNames - the columns actually being written, for `pk-changed`.
 * @returns the `[column, value]` operands, in a deterministic order.
 */
function identityOperands(mode, mutation, primaryKey, changedNames) {
  if (primaryKey.length === 0) {
    throw new Error('该表没有主键，无法安全定位唯一一行，因此不支持编辑或删除。')
  }
  const key = plainObject(mutation.key)
  const operands = primaryKey.map(name => {
    if (!Object.prototype.hasOwnProperty.call(key, name)) {
      throw new Error(`缺少主键列 ${name} 的原值，无法定位这一行`)
    }
    return [name, bindValue(key[name])]
  })
  if (mode === 'pk') return operands

  const original = plainObject(mutation.original)
  for (const name of changedNames) {
    // Primary-key columns are already in the operands, under their ORIGINAL
    // values — which is also what lets a commit rename a key column.
    if (primaryKey.includes(name)) continue
    if (!Object.prototype.hasOwnProperty.call(original, name)) {
      throw new Error(`并发校验需要列 ${name} 的原值`)
    }
    operands.push([name, bindValue(original[name])])
  }
  return operands
}

/** Render `col <=> ? AND …`. */
function whereSql(operands) {
  return operands.map(([name]) => `${quoteId(name)} <=> ?`).join(' AND ')
}

/**
 * Turn one submitted mutation into a single parameterized statement.
 *
 * Pure and total: it reads only its arguments, never a connection, so the whole
 * safety surface (identifier validation, no-op filtering, NULL-safe identity,
 * value binding) is directly testable without a database.
 *
 * @param request - database, table, the table's columns and primary key, the
 *   concurrency mode, and the mutation itself.
 * @returns the plan, or `null` when an update changes nothing.
 * @throws when a column is missing/unwritable, a key is incomplete, or the table
 *   has no primary key.
 */
export function buildMutationPlan(request) {
  const { database, table, columnMap, primaryKey, mutation } = request
  if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
  if (!isSafeIdentifier(table)) throw new Error(`非法的表名：${table}`)
  const mode = CONCURRENCY_MODES.includes(request.concurrency) ? request.concurrency : DEFAULT_CONCURRENCY
  const target = quoteTable(database, table)
  const kind = plainObject(mutation).kind

  if (kind === 'update') {
    const set = plainObject(mutation.set)
    const original = plainObject(mutation.original)
    const assignments = []
    for (const name of Object.keys(set)) {
      writableColumn(name, columnMap)
      const bound = bindValue(set[name])
      // A cell the user typed back to its loaded value is not an edit; dropping
      // it here is what keeps a "no changes" commit from writing anything.
      if (sameValue(bound, original[name])) continue
      assignments.push([name, bound])
    }
    if (assignments.length === 0) return null

    // Only the columns that survived no-op filtering widen the WHERE; a cell the
    // user typed back to its loaded value must not tighten the concurrency check.
    const operands = identityOperands(mode, mutation, primaryKey, assignments.map(([name]) => name))
    const sql = `UPDATE ${target} SET ${assignments.map(([name]) => `${quoteId(name)} = ?`).join(', ')}`
      + ` WHERE ${whereSql(operands)}`
    return {
      kind,
      sql,
      values: [...assignments.map(([, value]) => value), ...operands.map(([, value]) => value)],
    }
  }

  if (kind === 'delete') {
    // A delete writes nothing, so there are no changed columns to tighten on.
    const operands = identityOperands(mode, mutation, primaryKey, [])
    return { kind, sql: `DELETE FROM ${target} WHERE ${whereSql(operands)}`, values: operands.map(([, value]) => value) }
  }

  if (kind === 'insert') {
    const values = plainObject(mutation.values)
    const names = Object.keys(values)
    if (names.length === 0) throw new Error('新增行至少要填一列')
    for (const name of names) writableColumn(name, columnMap)
    const sql = `INSERT INTO ${target} (${names.map(quoteId).join(', ')})`
      + ` VALUES (${names.map(() => '?').join(', ')})`
    return { kind, sql, values: names.map(name => bindValue(values[name])) }
  }

  throw new Error(`未知的改动类型：${String(kind)}`)
}

/**
 * Build and (unless this is a dry run) execute a set of mutations in ONE
 * transaction.
 *
 * The dry run exists so the browser can show the reader the exact statements a
 * commit would run — the same builder feeds both paths, so the preview cannot
 * drift from what executes.
 *
 * Every write is verified: an update or delete must affect exactly one row.
 * Zero means the row moved or vanished since the page was loaded (a conflict,
 * reported as such); more than one means the identity was not unique, and the
 * transaction is rolled back rather than corrupting more rows.
 *
 * @param pool - the connection's pool.
 * @param request - database, table, concurrency, mutations, and `dryRun`.
 * @returns the planned statements, per-mutation results, and skipped no-ops.
 */
export async function applyMutations(pool, request) {
  const { database, table } = request
  if (!isSafeIdentifier(database)) throw new Error(`非法的库名：${database}`)
  if (!isSafeIdentifier(table)) throw new Error(`非法的表名：${table}`)

  const mutations = Array.isArray(request.mutations) ? request.mutations : []
  if (mutations.length === 0) throw new Error('没有待提交的改动')

  const columns = await listColumns(pool, database, table)
  const columnMap = new Map(columns.map(column => [column.name, column]))
  const primaryKey = await primaryKeyOf(pool, database, table)

  const plans = []
  const skipped = []
  mutations.forEach((mutation, index) => {
    const plan = buildMutationPlan({
      database,
      table,
      columnMap,
      primaryKey,
      concurrency: request.concurrency,
      mutation,
    })
    if (plan === null) skipped.push(index)
    else plans.push(plan)
  })

  const mysql = loadMysql()
  // The driver's own escaper, so the preview is exactly what MySQL would receive.
  const statements = plans.map(plan => mysql.format(plan.sql, plan.values))

  if (plans.length === 0) {
    return { dryRun: true, statements: [], skipped, results: [], primaryKey }
  }
  if (request.dryRun === true) {
    return { dryRun: true, statements, skipped, results: [], primaryKey }
  }

  const connection = await pool.getConnection()
  const results = []
  try {
    await connection.beginTransaction()
    for (const [index, plan] of plans.entries()) {
      const [result] = await connection.query({
        sql: plan.sql,
        values: plan.values,
        timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
      })
      const affected = Number(result?.affectedRows ?? 0)
      if (plan.kind === 'insert') {
        if (affected !== 1) throw new Error(`新增行影响了 ${affected} 行（预期 1 行），已回滚`)
        results.push({ kind: plan.kind, statement: statements[index], affectedRows: affected, insertId: result?.insertId ?? null })
        continue
      }
      if (affected === 0) {
        throw new MutationConflictError(
          plan.kind === 'delete'
            ? '这一行已经不在了（或已被他人改动），删除已回滚。请刷新后重试。'
            : '这一行已被他人改动或不复存在，提交已回滚。请刷新后重试。',
        )
      }
      if (affected > 1) {
        throw new Error(`该条件定位到 ${affected} 行（预期 1 行），已回滚。该表的唯一性不足以安全定位单行。`)
      }
      results.push({ kind: plan.kind, statement: statements[index], affectedRows: affected })
    }
    await connection.commit()
    return { dryRun: false, statements, skipped, results, primaryKey, committed: true }
  } catch (error) {
    try {
      await connection.rollback()
    } catch {
      // A rollback on a connection the server already closed has nothing to undo.
    }
    throw error
  } finally {
    connection.release()
  }
}
