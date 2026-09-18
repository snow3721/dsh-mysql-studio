/**
 * dsh-mysql-studio — host half.
 *
 * Publishes one fenced JSON API under `/mysql-studio/api` and owns the MySQL
 * pools behind it. The browser half is a thin client of this surface, so every
 * credential, socket, and statement stays on the Node side.
 *
 * The same store and pools are also exposed to the model as read-only tools
 * (`./tools.js`), so the agent queries the connections the user configured
 * rather than a second, divergent set of credentials.
 *
 * The route carries the same browser-trust fence the `/api` gateway uses: the
 * Host header must name loopback, or an authority the web runtime already
 * trusts. Without it a page on another origin could reach a database through
 * the user's own process.
 */
import { ConnectionStore, dshHome, parseConnectionUrl, publicProfile, storePath } from './store.js'
import {
  applyMutations,
  assertCreateDatabaseSql,
  assertCreateTableSql,
  buildCreateDatabaseSql,
  buildCreateTableSql,
  fetchRows,
  listColumns,
  listDatabases,
  listTables,
  PoolRegistry,
  runQuery,
  runReadOnlyQuery,
  runSchemaChange,
  testProfile,
} from './db.js'
import { registerModelTools } from './tools.js'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-mysql-studio'

/** The webserver is the carrier this half cannot work without. */
export const inject = ['webServer']

/** The path prefix this plugin owns. */
const API_PREFIX = '/mysql-studio/api'

/** Refuse a JSON body larger than this; connection profiles are small. */
const MAX_BODY_BYTES = 256 * 1024

/** Loopback hostnames that never need the trusted-host list. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])

/** The hostname out of a `Host` header, without its port. */
function hostnameOf(header) {
  const raw = String(header ?? '').trim().toLowerCase()
  if (raw === '') return ''
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    return end === -1 ? raw : raw.slice(1, end)
  }
  const colon = raw.lastIndexOf(':')
  return colon === -1 ? raw : raw.slice(0, colon)
}

/**
 * Decide whether a request comes from the browser this process serves.
 *
 * Loopback always passes. Anything else passes only when the web runtime lists
 * it among its trusted hosts, which is how a LAN-configured `dsh web` keeps
 * working without this plugin inventing a second trust list.
 *
 * @param req - the incoming request.
 * @param webRuntime - the web runtime service, when mounted.
 * @returns whether the request may reach the database API.
 */
function isTrusted(req, webRuntime) {
  const hostname = hostnameOf(req.headers.host)
  if (hostname === '' || LOOPBACK.has(hostname)) return true
  const trusted = webRuntime?.trustedHosts
  if (trusted === undefined || trusted === null) return false
  const entries = typeof trusted[Symbol.iterator] === 'function' ? [...trusted] : []
  return entries.some(entry => {
    const candidate = hostnameOf(String(entry))
    return candidate !== '' && candidate === hostname
  })
}

/** Write one JSON response. */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read and parse a JSON request body, refusing anything oversized or malformed. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** A required string field out of a JSON payload. */
function requireString(payload, key) {
  const value = payload === null || typeof payload !== 'object' ? undefined : payload[key]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`缺少参数 ${key}`)
  return value.trim()
}

/**
 * Build the API method table.
 *
 * Every method takes the parsed JSON payload and returns a JSON value; failures
 * reject and are reported as `{ ok: false, error }` by the route.
 *
 * @param store - the connection profile store.
 * @param registry - the pool registry.
 * @param toolStatus - live model-tool registration status, reported by `health`.
 * @returns the dispatch table.
 */
function buildApi(store, registry, toolStatus) {
  /** Load one profile by id, with a message that names the missing row. */
  const profileOf = async (payload) => {
    const id = requireString(payload, 'id')
    const profile = await store.get(id)
    if (profile === undefined) throw new Error(`未知的连接 id：${id}`)
    return profile
  }

  return {
    /**
     * Liveness and version report for the client's status strip.
     *
     * `modelTools` is here for a specific reason: the tool registry is an
     * optional dependency, so a process where it never mounted looks completely
     * healthy from the sidebar. This is how a self-check can ask the RUNNING
     * process whether the agent surface came up, rather than trusting that the
     * source registers it.
     *
     * It reports each tool's parameter names because tool names alone cannot
     * distinguish one generation of the surface from the next — and "the restart
     * did not take" is this plugin's most-repeated failure.
     */
    health: () => ({
      ok: true,
      plugin: name,
      node: process.version,
      storePath: storePath(),
      dshHome: dshHome(),
      modelTools: {
        registryMounted: toolStatus.registryMounted,
        tools: toolStatus.tools.map(tool => ({ name: tool.name, parameters: [...tool.parameters] })),
      },
    }),

    'conn.list': async () => ({
      connections: (await store.list()).map(publicProfile),
      storePath: storePath(),
    }),

    'conn.save': async (payload) => {
      const profile = await store.save(payload?.draft ?? payload)
      // A saved edit invalidates the cached pool through the revision key; an
      // explicit close here also releases sockets the old profile opened.
      await registry.close(profile.id)
      return { connection: publicProfile(profile) }
    },

    'conn.delete': async (payload) => {
      const id = requireString(payload, 'id')
      await registry.close(id)
      const removed = await store.remove(id)
      if (!removed) throw new Error(`未知的连接 id：${id}`)
      return { ok: true }
    },

    /**
     * Probe a connection.
     *
     * Three shapes are accepted, because the editor needs all three:
     * `{ id }` probes a saved profile; `{ draft }` probes an unsaved one; and
     * `{ id, draft }` probes an edit in progress — merged over the stored
     * profile, so an untouched password box still tests the saved secret rather
     * than an empty one.
     */
    'conn.test': async (payload) => {
      const record = payload !== null && typeof payload === 'object' ? payload : {}
      const isDraft = record.draft !== undefined
      let profile
      if (isDraft) {
        const existing = record.id === undefined ? undefined : await store.get(String(record.id))
        const { normalizeProfile } = await import('./store.js')
        profile = normalizeProfile(record.draft, existing)
      } else {
        profile = await profileOf(record)
      }
      return testProfile(profile)
    },

    /** Expand a pasted URL into form fields without saving anything. */
    'conn.parseUrl': (payload) => ({ draft: parseConnectionUrl(requireString(payload, 'url')) }),

    'catalog.databases': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      return { databases: await listDatabases(pool) }
    },

    'catalog.tables': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      return { tables: await listTables(pool, requireString(payload, 'database')) }
    },

    'catalog.columns': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      return {
        columns: await listColumns(pool, requireString(payload, 'database'), requireString(payload, 'table')),
      }
    },

    'data.rows': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      return fetchRows(pool, {
        database: requireString(payload, 'database'),
        table: requireString(payload, 'table'),
        limit: payload?.limit,
        offset: payload?.offset,
      })
    },

    /**
     * Commit (or preview) a set of row edits, inserts, and deletes.
     *
     * `dryRun: true` returns the exact statements a commit would send, which is
     * what the workbench shows for confirmation. Both paths run through the same
     * builder, so the preview cannot drift from what executes.
     */
    'data.mutate': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      return applyMutations(pool, {
        database: requireString(payload, 'database'),
        table: requireString(payload, 'table'),
        concurrency: payload?.concurrency,
        mutations: payload?.mutations,
        dryRun: payload?.dryRun === true,
      })
    },

    'query.run': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      return runReadOnlyQuery(pool, {
        sql: requireString(payload, 'sql'),
        database: payload?.database,
        limit: payload?.limit,
      })
    },

    /**
     * The SQL console. Reads run immediately; writes return a preview unless
     * `confirmSql` is the exact statement that was shown.
     */
    'query.exec': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      return runQuery(pool, {
        sql: requireString(payload, 'sql'),
        database: payload?.database,
        limit: payload?.limit,
        dryRun: payload?.dryRun === true,
        confirmSql: typeof payload?.confirmSql === 'string' ? payload.confirmSql : undefined,
      })
    },

    'schema.createDatabase': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      const raw = payload?.sql
      const sql = typeof raw === 'string' && raw.trim() !== ''
        ? assertCreateDatabaseSql(raw)
        : buildCreateDatabaseSql(payload)
      return runSchemaChange(pool, {
        sql,
        dryRun: payload?.dryRun === true,
        confirmSql: typeof payload?.confirmSql === 'string' ? payload.confirmSql : undefined,
      })
    },

    'schema.createTable': async (payload) => {
      const profile = await profileOf(payload)
      const pool = await registry.poolFor(profile)
      const database = requireString(payload, 'database')
      const raw = payload?.sql
      const sql = typeof raw === 'string' && raw.trim() !== ''
        ? assertCreateTableSql(raw)
        : buildCreateTableSql({ ...payload, database })
      return runSchemaChange(pool, {
        sql,
        database,
        dryRun: payload?.dryRun === true,
        confirmSql: typeof payload?.confirmSql === 'string' ? payload.confirmSql : undefined,
      })
    },
  }
}

/**
 * Plugin body: publish the API route and own the pool lifecycle.
 * @param ctx - host plugin context (webServer).
 * @param _config - reserved; this plugin takes config through the UI.
 */
export function apply(ctx, _config) {
  const store = new ConnectionStore()
  const registry = new PoolRegistry()
  // The agent half: the same store and pools, reached through the tool registry
  // instead of HTTP. Optional by design — see registerModelTools.
  const toolStatus = registerModelTools(ctx, { store, registry })
  const api = buildApi(store, registry, toolStatus)
  const webRuntime = ctx.get('webRuntime')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!isTrusted(req, webRuntime)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'only POST is served' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(API_PREFIX + '/') ? pathname.slice(API_PREFIX.length + 1) : ''
      if (method === '' || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
        return
      }
      const handlerFn = api[method]
      if (handlerFn === undefined) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${method}"` } })
        return
      }
      try {
        const payload = await readJsonBody(req)
        writeJson(res, 200, { ok: true, result: await handlerFn(payload) })
      } catch (error) {
        writeJson(res, 400, {
          ok: false,
          error: {
            code: error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'request-failed',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    },
  }), 'dsh-mysql-studio: /mysql-studio/api routes')

  // Pools hold live sockets; the plugin's own fiber is what releases them.
  ctx.effect(() => () => {
    void registry.closeAll()
  }, 'dsh-mysql-studio: pool teardown')

  ctx.logger?.info?.(`[dsh-mysql-studio] API ready at ${API_PREFIX} (profiles: ${storePath()})`)
}
