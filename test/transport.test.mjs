/**
 * dsh-mysql-studio — connection-shape tests after the transport cut.
 *
 * The plugin reaches MySQL over TCP only. Older documents may still carry
 * `transport` / `ssh` / `socketPath` / dropped TLS modes; those fields must fold
 * into a direct TCP profile rather than be stored as a second way to connect.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { connectionOptions, normalizeProfile, parseConnectionUrl, SSL_MODES } = await import('../lib/store.js')
const { PoolRegistry, testProfile } = await import('../lib/db.js')

const LIVE_URL = process.env.DSH_MYSQL_STUDIO_TEST_URL ?? 'mysql://root:root@192.168.100.128:3307'
const parsed = parseConnectionUrl(LIVE_URL)

test('TLS vocabulary is the three modes the form still offers', () => {
  assert.deepEqual(SSL_MODES, ['disabled', 'required', 'verify-ca'])
})

test('a profile is always a direct TCP connection', () => {
  const profile = normalizeProfile({ host: 'db.internal', user: 'u' })
  assert.equal(profile.host, 'db.internal')
  assert.equal(profile.port, 3306)
  assert.equal(profile.transport, undefined)
  assert.equal(profile.socketPath, undefined)
  assert.equal(profile.ssh, undefined)
})

test('leftover ssh / socket fields are not stored', () => {
  const profile = normalizeProfile({
    host: 'db.internal',
    user: 'root',
    transport: 'ssh',
    socketPath: '/tmp/mysql.sock',
    ssh: { host: 'jump', user: 'me', password: 'jumpsecret' },
  })
  assert.equal(profile.host, 'db.internal')
  assert.equal(profile.transport, undefined)
  assert.equal(profile.socketPath, undefined)
  assert.equal(profile.ssh, undefined)
})

test('a profile with no host is refused instead of dialling localhost', () => {
  // mysql2 treats an undefined `host` as `localhost`. A profile that lost its host
  // — what the removed Socket transport left behind, because host was optional then
  // and the key is simply absent — must never reach the driver: on a box that runs
  // its own MySQL with matching credentials it would connect to the WRONG database
  // and report no error at all. A refusal is the difference between a confusing
  // error and a wrong answer.
  assert.throws(() => connectionOptions({ user: 'u', password: 'p', port: 3306 }), /没有主机/)
  assert.throws(() => connectionOptions({ host: '', user: 'u' }), /没有主机/)
  // And the guard is about the host actually being dialled, not about the profile.
  assert.throws(() => connectionOptions({ host: 'h', user: 'u' }, undefined, { host: undefined, port: 1 }), /没有主机/)
})

test('a leftover socket profile says what happened instead of just demanding a host', () => {
  // The exact shape 0.5.0 stored for a socket connection: `transport: 'socket'`
  // with a `socketPath` and NO host key, because that transport did not need one.
  const socketProfile = {
    id: 'x',
    name: 'legacy-socket',
    transport: 'socket',
    socketPath: '/var/run/mysqld/mysqld.sock',
    port: 3306,
    user: 'root',
    password: 'pw',
  }

  assert.throws(() => normalizeProfile({}, socketProfile), error => {
    // "host is required" would be true but useless — the reader never had a host
    // to give. The message has to name the real cause and the way out.
    assert.match(error.message, /Socket/)
    assert.match(error.message, /mysqld\.sock/, 'it names the path it found')
    assert.match(error.message, /编辑/)
    return true
  })

  // With a host present the same leftovers still fold into a direct TCP profile.
  const migrated = normalizeProfile({}, { ...socketProfile, host: 'db.internal' })
  assert.equal(migrated.host, 'db.internal')
  assert.equal(migrated.transport, undefined)
  assert.equal(migrated.socketPath, undefined)
})

test('a profile stored before transports existed still connects directly', () => {
  const legacy = { id: 'c1', name: 'old', host: '127.0.0.1', port: 3306, user: 'root' }
  const options = connectionOptions(legacy)
  assert.equal(options.host, '127.0.0.1')
  assert.equal(options.port, 3306)
  assert.equal(options.socketPath, undefined)

  const migrated = normalizeProfile(legacy)
  assert.equal(migrated.host, '127.0.0.1')
  assert.equal(migrated.transport, undefined)
})

test('dropped TLS modes fold onto the ones that remain', () => {
  assert.equal(normalizeProfile({ host: 'h', user: 'u', ssl: { mode: 'preferred' } }).ssl.mode, 'required')
  assert.equal(normalizeProfile({ host: 'h', user: 'u', ssl: { mode: 'verify-identity' } }).ssl.mode, 'verify-ca')
  assert.equal(normalizeProfile({ host: 'h', user: 'u', ssl: { mode: 'required' } }).ssl.mode, 'required')
})

test('client certificates are not kept', () => {
  const profile = normalizeProfile({
    host: 'h',
    user: 'u',
    ssl: { mode: 'required', ca: 'CA', cert: 'CERT', key: 'KEY', passphrase: 'pw' },
  })
  assert.equal(profile.ssl.ca, 'CA')
  assert.equal(profile.ssl.cert, undefined)
  assert.equal(profile.ssl.key, undefined)
  assert.equal(profile.ssl.passphrase, undefined)
  assert.equal(connectionOptions(profile).ssl.cert, undefined)
  assert.equal(connectionOptions(profile).ssl.key, undefined)
})

test('connectionOptions is always host and port', () => {
  const options = connectionOptions(normalizeProfile({ host: 'db.internal', port: 3307, user: 'u' }))
  assert.equal(options.host, 'db.internal')
  assert.equal(options.port, 3307)
  assert.equal(options.socketPath, undefined)
})

test('a URL ssl-mode of preferred or verify-identity folds the same way', () => {
  assert.equal(parseConnectionUrl('mysql://u@h/db?ssl-mode=preferred').ssl.mode, 'required')
  assert.equal(parseConnectionUrl('mysql://u@h/db?ssl-mode=verify-identity').ssl.mode, 'verify-ca')
  assert.equal(parseConnectionUrl('mysql://u@h/db?ssl-mode=disabled').ssl.mode, 'disabled')
})

test('a pre-cut profile goes through the pool as a direct connection', async t => {
  let reachable = true
  try {
    await testProfile(normalizeProfile({ ...parsed, name: 'live', connectTimeoutMs: 4000 }))
  } catch {
    reachable = false
  }
  if (!reachable) {
    t.skip('MySQL unreachable')
    return
  }
  const registry = new PoolRegistry()
  try {
    const legacy = normalizeProfile({
      name: 'legacy-tcp',
      connectTimeoutMs: 8000,
      ...parsed,
    })
    const pool = await registry.poolFor(legacy)
    const [rows] = await pool.query('SELECT 1 AS n')
    assert.equal(rows[0].n, 1)
  } finally {
    await registry.closeAll()
  }
})
