/**
 * dsh-mysql-studio — connection profiles.
 *
 * A DataGrip-shaped connection profile is a named, persisted description of how
 * to reach one MySQL server: basic TCP fields, an optional TLS block, and an
 * optional "paste a URL" entry point that expands into those fields.
 *
 * Profiles live in one JSON document under the DSH home
 * (`<DSH_HOME>/mysql-studio/connections.json`), written atomically. Passwords
 * are the one field the renderer never hands back to the browser: reads return
 * `hasPassword` instead, and a profile may name an environment variable
 * (`passwordEnv`) so the secret never reaches the document at all.
 *
 * This module owns shape only — validation, normalization, URL parsing, and TLS
 * mapping. It never opens a socket.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The DSH home directory, the root every durable plugin document sits under. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** The one document this plugin owns. */
export function storePath() {
  return join(dshHome(), 'mysql-studio', 'connections.json')
}

/** TLS modes the form still offers. Older profiles are folded in on read. */
export const SSL_MODES = ['disabled', 'required', 'verify-ca']

/** Modes this version no longer keeps, mapped onto one it does. */
const LEGACY_SSL_MODES = {
  preferred: 'required',
  'verify-identity': 'verify-ca',
}

const DOCUMENT_VERSION = 1
const DEFAULT_PORT = 3306
/** Long enough for a slow VPN, short enough to fail visibly. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10000

/** A plain object, or an empty one — the guard every draft read goes through. */
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/** Trim a value down to a non-empty string, or `undefined`. */
function text(value) {
  if (value === undefined || value === null) return undefined
  const trimmed = String(value).trim()
  return trimmed === '' ? undefined : trimmed
}

/** An integer inside `[min, max]`, or `undefined` when the value is not one. */
function integerIn(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return undefined
  return parsed
}

/** A MySQL identifier safe to interpolate once back-quoted: letters, digits, `_`, `$`. */
export function isSafeIdentifier(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_$]+$/.test(name)
}

/** Back-quote an identifier, escaping any embedded backtick. */
export function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`'
}

/** Back-quote a qualified `database.table` pair. */
export function quoteTable(database, table) {
  return quoteId(database) + '.' + quoteId(table)
}

/** A short, collision-resistant profile id. */
function mintId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/**
 * Normalize a TLS block.
 *
 * Accepts `{ mode, ca }`, plus a bare boolean (`true` → `required`). Dropped
 * modes fold in: `preferred` becomes `required`, `verify-identity` becomes
 * `verify-ca`. An unrecognized mode degrades to `disabled`. Client certificates
 * are ignored — this plugin no longer carries them.
 */
function normalizeSsl(input) {
  if (input === true) return { mode: 'required' }
  if (input === undefined || input === null || input === false) return { mode: 'disabled' }
  if (typeof input !== 'object') return { mode: 'disabled' }
  const raw = typeof input.mode === 'string' ? input.mode : 'disabled'
  const mode = SSL_MODES.includes(raw) ? raw : (LEGACY_SSL_MODES[raw] ?? 'disabled')
  const ca = text(input.ca)
  return { mode, ...(ca === undefined ? {} : { ca }) }
}

/**
 * Expand a pasted connection URL into profile fields.
 *
 * Three shapes are accepted, because that is what people actually paste:
 *   mysql://user:pass@host:3306/db?charset=utf8mb4&ssl-mode=required
 *   jdbc:mysql://host:3306/db?user=root&password=root&useSSL=true&connectTimeout=5000
 *   host:3306/db                     (bare; credentials filled in by hand)
 *
 * Query parameters fold into the same field vocabulary the form uses, so a
 * pasted URL and a hand-filled form converge on one profile shape. Timeouts
 * follow each dialect's own unit: JDBC's `connectTimeout` is milliseconds, the
 * native MySQL URI's `connect-timeout` is seconds.
 *
 * @param input - the pasted text.
 * @returns a partial profile draft; never throws — unusable input yields `{}`.
 */
export function parseConnectionUrl(input) {
  const raw = text(input)
  if (raw === undefined) return {}

  let work = raw
  if (/^jdbc:mysql:\/\//i.test(work)) work = work.replace(/^jdbc:mysql:\/\//i, 'mysql://')
  // A bare `host:port/db` is the common "just give me the address" paste.
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(work)) work = 'mysql://' + work

  let url
  try {
    url = new URL(work)
  } catch {
    return {}
  }

  const draft = {}
  const host = text(decodeURIComponent(url.hostname))
  if (host !== undefined) draft.host = host
  const port = integerIn(url.port, 1, 65535)
  if (port !== undefined) draft.port = port
  if (url.username !== '') draft.user = decodeURIComponent(url.username)
  if (url.password !== '') draft.password = decodeURIComponent(url.password)

  const database = text(decodeURIComponent(url.pathname.replace(/^\//, '')))
  if (database !== undefined) draft.database = database

  // JDBC keeps credentials in the query string; the native URI puts them in
  // userinfo. Both land on the same two fields.
  const params = url.searchParams
  const user = text(params.get('user'))
  if (user !== undefined && draft.user === undefined) draft.user = user
  const password = text(params.get('password'))
  if (password !== undefined && draft.password === undefined) draft.password = password

  const charset = text(params.get('charset')) ?? text(params.get('characterEncoding'))
  if (charset !== undefined) draft.charset = charset

  const jdbcTimeoutMs = integerIn(params.get('connectTimeout'), 1, 600000)
  const nativeTimeoutSec = integerIn(params.get('connect-timeout'), 1, 600)
  if (jdbcTimeoutMs !== undefined) draft.connectTimeoutMs = jdbcTimeoutMs
  else if (nativeTimeoutSec !== undefined) draft.connectTimeoutMs = nativeTimeoutSec * 1000

  // TLS: Connector/J 8 spells it `ssl-mode`, older JDBC `useSSL`, the native
  // MySQL URI `ssl-mode`.
  const sslMode = text(params.get('ssl-mode')) ?? text(params.get('sslMode'))
  const useSsl = text(params.get('useSSL')) ?? text(params.get('useSsl'))
  if (sslMode !== undefined) {
    const normalized = sslMode.toUpperCase().replace(/_/g, '-')
    const mode = normalized === 'DISABLED'
      ? 'disabled'
      : normalized === 'VERIFY-CA' || normalized === 'VERIFY-IDENTITY'
        ? 'verify-ca'
        : 'required'
    draft.ssl = { mode }
  } else if (useSsl !== undefined) {
    draft.ssl = { mode: /^(true|1|yes)$/i.test(useSsl) ? 'required' : 'disabled' }
  }

  return draft
}

/**
 * Normalize an arbitrary draft into a stored profile.
 *
 * A `url` field is expanded first and the explicit form fields win over it, so
 * "paste a URL, then fix the port" behaves the way it reads. `existing` supplies
 * what a partial save omits — most importantly the password, which the browser
 * never round-trips: omitting the `password` key keeps the stored one, while an
 * explicit empty string clears it.
 *
 * @param draft - what the caller supplied.
 * @param existing - the profile being edited, when there is one.
 * @returns the normalized profile, ready to persist.
 * @throws when a required field is missing after normalization.
 */
export function normalizeProfile(draft, existing) {
  const source = plain(draft)
  const base = plain(existing)
  const fromUrl = text(source.url) !== undefined ? parseConnectionUrl(source.url) : {}
  // URL-derived values sit under the explicit form fields.
  const merged = { ...fromUrl, ...source }

  const host = text(merged.host) ?? text(base.host)
  const user = text(merged.user) ?? text(base.user)
  if (host === undefined) {
    // A profile with a stored socket path and no host is what the removed Socket
    // transport left behind: host was optional then, so the key is simply absent
    // and "host is required" would be true but useless — the reader never had a
    // host to give. Say what actually happened and what to do about it.
    const hadSocket = text(merged.socketPath) ?? text(base.socketPath)
    throw new Error(hadSocket === undefined
      ? '连接主机（host）不能为空'
      : `这条连接用的是已移除的 Socket 传输（当时不需要填主机）：请编辑它，填写主机与端口后保存。原 socket 路径为 ${hadSocket}`)
  }
  if (user === undefined) throw new Error('连接用户名（user）不能为空')

  const name = text(merged.name) ?? text(base.name) ?? `${user}@${host}`
  const port = integerIn(merged.port, 1, 65535) ?? integerIn(base.port, 1, 65535) ?? DEFAULT_PORT

  let password = base.password
  if (Object.prototype.hasOwnProperty.call(source, 'password') && source.password !== undefined) {
    password = source.password === null ? undefined : String(source.password)
  } else if (fromUrl.password !== undefined) {
    password = fromUrl.password
  }

  const passwordEnv = text(merged.passwordEnv) ?? text(base.passwordEnv)
  const database = text(merged.database) ?? text(base.database)
  const charset = text(merged.charset) ?? text(base.charset)
  const connectTimeoutMs = integerIn(merged.connectTimeoutMs, 1000, 600000)
    ?? integerIn(base.connectTimeoutMs, 1000, 600000)
    ?? DEFAULT_CONNECT_TIMEOUT_MS

  const now = new Date().toISOString()
  return {
    id: text(base.id) ?? mintId(),
    name,
    host,
    port,
    user,
    ...(password === undefined ? {} : { password }),
    ...(passwordEnv === undefined ? {} : { passwordEnv }),
    ...(database === undefined ? {} : { database }),
    ...(charset === undefined ? {} : { charset }),
    ssl: normalizeSsl(merged.ssl !== undefined ? merged.ssl : base.ssl),
    connectTimeoutMs,
    createdAt: text(base.createdAt) ?? now,
    updatedAt: now,
  }
}

/**
 * The public face of a profile: everything the browser needs to render and edit
 * it, minus every secret.
 *
 * The database password is replaced by a presence flag, which is what the form
 * renders as "已保存，留空则不修改". Leftover SSH / socket / client-certificate
 * fields from an older document are dropped rather than echoed: those surfaces
 * no longer exist, and their secrets must not cross the wire because the form
 * no longer has a place to redact them.
 *
 * @param profile - the stored profile.
 * @returns the profile with no secret values anywhere in it.
 */
export function publicProfile(profile) {
  const { password, ssh, socketPath, transport, ssl, ...rest } = profile
  void ssh
  void socketPath
  void transport
  const safeSsl = ssl === undefined
    ? undefined
    : { mode: ssl.mode ?? 'disabled', ...(ssl.ca === undefined || ssl.ca === '' ? {} : { ca: ssl.ca }) }
  return {
    ...rest,
    ...(safeSsl === undefined ? {} : { ssl: safeSsl }),
    hasPassword: password !== undefined && password !== '',
  }
}

/** Resolve the password actually used to connect: environment first, then the stored value. */
export function resolvePassword(profile) {
  if (profile.passwordEnv !== undefined && process.env[profile.passwordEnv] !== undefined) {
    return process.env[profile.passwordEnv]
  }
  return profile.password ?? ''
}

/** Read the document, tolerating a missing file. */
async function readDocument() {
  let raw
  try {
    raw = await readFile(storePath(), 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return { version: DOCUMENT_VERSION, connections: [] }
    }
    throw new Error(`无法读取连接配置文件 ${storePath()}：${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`连接配置文件不是合法 JSON（${storePath()}）：${error instanceof Error ? error.message : String(error)}`)
  }
  const connections = Array.isArray(parsed?.connections) ? parsed.connections : []
  return { version: DOCUMENT_VERSION, connections }
}

/** Write the document atomically: a temp sibling, then a rename into place. */
async function writeDocument(document) {
  const target = storePath()
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(document, null, 2), 'utf8')
  await rename(tmp, target)
}

/**
 * The profile store: one JSON document, re-read per call so an external edit is
 * picked up without a restart, written atomically so a crash cannot truncate it.
 */
export class ConnectionStore {
  /**
   * Every stored profile, in document order.
   * @returns the normalized profiles.
   */
  async list() {
    return (await readDocument()).connections
  }

  /**
   * One profile by id.
   * @param id - the profile id.
   * @returns the profile, or `undefined`.
   */
  async get(id) {
    return (await this.list()).find(entry => entry.id === id)
  }

  /**
   * Insert or update one profile.
   * @param draft - the incoming fields; `id` selects the row to replace.
   * @returns the stored profile.
   * @throws when the draft is incomplete or the id is unknown.
   */
  async save(draft) {
    const document = await readDocument()
    const id = text(plain(draft).id)
    const index = id === undefined ? -1 : document.connections.findIndex(entry => entry.id === id)
    if (id !== undefined && index === -1) throw new Error(`未知的连接 id：${id}`)

    const existing = index === -1 ? undefined : document.connections[index]
    const profile = normalizeProfile(draft, existing)
    if (index === -1) document.connections.push(profile)
    else document.connections[index] = profile

    await writeDocument({ version: DOCUMENT_VERSION, connections: document.connections })
    return profile
  }

  /**
   * Remove one profile.
   * @param id - the profile id.
   * @returns whether a row was removed.
   */
  async remove(id) {
    const document = await readDocument()
    const next = document.connections.filter(entry => entry.id !== id)
    if (next.length === document.connections.length) return false
    await writeDocument({ version: DOCUMENT_VERSION, connections: next })
    return true
  }
}

/**
 * The mysql2 connection options a profile resolves to.
 *
 * @param profile - the stored profile.
 * @param ca - PEM text for the CA, when the mode wants one.
 * @param endpoint - optional `{ host, port }` override; tests use this, the
 *   pool path usually does not.
 * @returns options for `mysql.createPool`.
 */
export function connectionOptions(profile, ca, endpoint) {
  const ssl = profile.ssl ?? { mode: 'disabled' }
  const target = endpoint ?? { host: profile.host, port: profile.port }

  // A missing host must never reach the driver. mysql2 treats an undefined `host`
  // as `localhost`, so a profile that lost its host — a leftover Socket profile is
  // the real case, where the host key was optional and therefore absent — would
  // silently dial the LOCAL machine instead of erroring. On a box that happens to
  // run its own MySQL with matching credentials, that connects to the wrong
  // database and says nothing. Refusing here is the difference between a
  // confusing error and a wrong answer.
  if (target.host === undefined || target.host === '') {
    throw new Error(
      '这条连接没有主机，无法连接：驱动会把缺失的主机当成 localhost，这不是你要连的机器。'
      + '请编辑该连接并填写主机与端口。',
    )
  }

  const options = {
    host: target.host,
    port: target.port,
    user: profile.user,
    password: resolvePassword(profile),
    connectTimeout: profile.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    charset: profile.charset ?? 'utf8mb4',
    // Lossless numerics: an out-of-range BIGINT/DECIMAL becomes a string rather
    // than a silently rounded Number; in-range values stay numbers.
    supportBigNumbers: true,
    bigNumberStrings: false,
    // DATE/DATETIME/TIMESTAMP arrive as the server's own text, so the grid shows
    // what the database holds instead of a locale-shifted Date.
    dateStrings: true,
    // One statement per round trip: the read path never needs more, and this is
    // the setting that turns a stray `;` into an error instead of a second query.
    multipleStatements: false,
    namedPlaceholders: false,
  }

  if (ssl.mode !== 'disabled') {
    options.ssl = {
      rejectUnauthorized: ssl.mode === 'verify-ca',
      ...(ca === undefined ? {} : { ca }),
    }
  }

  if (profile.database !== undefined) options.database = profile.database
  return options
}
