/**
 * dsh-mysql-studio — TLS mode tests against a real MySQL server.
 *
 * The unit tests pin down how a profile's TLS mode maps onto mysql2's options.
 * These answer the question that mapping cannot: does the driver actually DO
 * something different per mode? A mode that silently degrades to plaintext would
 * pass every unit test and still be a security bug, so each mode is checked
 * against the server's own report of the cipher it negotiated.
 *
 * The server here uses its auto-generated self-signed certificate, which makes
 * the two families distinguishable in exactly the way that matters:
 *
 *   disabled / required              -> connect (no verification)
 *   verify-ca                        -> refuse an untrusted certificate
 *   verify-ca + the server's own CA  -> connect (the `ca` plumbing works)
 *
 * Skipped, never failed, when the server is unreachable.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { connectionOptions, normalizeProfile, parseConnectionUrl } = await import('../lib/store.js')
const { loadMysql, runReadOnlyQuery, testProfile, PoolRegistry } = await import('../lib/db.js')

const LIVE_URL = process.env.DSH_MYSQL_STUDIO_TEST_URL ?? 'mysql://root:root@192.168.100.128:3307'
const parsed = parseConnectionUrl(LIVE_URL)

/** A profile in one TLS mode. */
const profileWith = (mode, ca) => normalizeProfile({
  name: 'tls-probe',
  connectTimeoutMs: 8000,
  ...parsed,
  ssl: ca === undefined ? { mode } : { mode, ca },
})

/** Wrap a DER certificate as PEM text, the form `ssl.ca` accepts. */
function pemOf(certificate) {
  const base64 = Buffer.from(certificate.raw).toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`
}

/**
 * Read the trust anchor the server presents, by opening one unverified TLS
 * connection and walking the chain to its self-signed root.
 *
 * @returns the root certificate as PEM, or null when TLS is unavailable.
 */
async function serverCaPem() {
  const mysql = loadMysql()
  let connection
  try {
    connection = await mysql.createConnection({ ...connectionOptions(profileWith('required')), database: undefined })
    const stream = (connection.connection ?? connection).stream
    if (typeof stream?.getPeerCertificate !== 'function') return null
    let certificate = stream.getPeerCertificate(true)
    if (certificate === null || certificate.raw === undefined) return null
    // Self-signed roots reference themselves; the fingerprint set ends the walk.
    const seen = new Set()
    while (certificate.issuerCertificate !== undefined
      && certificate.issuerCertificate !== null
      && !seen.has(certificate.issuerCertificate.fingerprint)) {
      seen.add(certificate.issuerCertificate.fingerprint)
      certificate = certificate.issuerCertificate
    }
    return { pem: pemOf(certificate), leaf: certificate.subject?.CN ?? null, san: certificate.subjectaltname ?? '' }
  } catch {
    return null
  } finally {
    if (connection !== undefined) await connection.end().catch(() => {})
  }
}

/** The cipher the server reports for one profile, or null when it refused. */
async function cipherFor(profile) {
  const registry = new PoolRegistry()
  try {
    const pool = await registry.poolFor(profile)
    const result = await runReadOnlyQuery(pool, { sql: "SHOW SESSION STATUS LIKE 'Ssl_cipher'" })
    const value = result.rows[0]?.[1]
    return typeof value === 'string' ? value : null
  } catch {
    return undefined
  } finally {
    await registry.closeAll()
  }
}

// Establish reachability once, so every test shares the same skip decision.
let reachable = true
try {
  await testProfile(profileWith('disabled'))
} catch {
  reachable = false
}
if (!reachable) console.log('  (live MySQL unavailable — TLS tests will skip)')

const serverCa = reachable ? await serverCaPem() : null

const requireLive = t => {
  if (!reachable) {
    t.skip('MySQL unreachable')
    return false
  }
  return true
}

// ── the mapping itself ──────────────────────────────────────────────────────

test('only verify-ca asks the driver to authenticate the server', () => {
  assert.equal(connectionOptions(profileWith('disabled')).ssl, undefined)
  assert.equal(connectionOptions(profileWith('required')).ssl.rejectUnauthorized, false)
  assert.equal(connectionOptions(profileWith('verify-ca')).ssl.rejectUnauthorized, true)
})

test('a supplied CA reaches the driver s ssl options', () => {
  // The CA is the driver's second argument, not read off the profile: a profile
  // may name a certificate FILE, and resolving that is the caller's job.
  const pem = '-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----'
  const options = connectionOptions(profileWith('verify-ca'), pem)
  assert.equal(options.ssl.ca, pem)
  assert.equal(connectionOptions(profileWith('verify-ca')).ssl.ca, undefined)
})

test('dropped modes fold before they reach the driver', () => {
  assert.equal(profileWith('preferred').ssl.mode, 'required')
  assert.equal(profileWith('verify-identity').ssl.mode, 'verify-ca')
  assert.equal(connectionOptions(profileWith('preferred')).ssl.rejectUnauthorized, false)
  assert.equal(connectionOptions(profileWith('verify-identity')).ssl.rejectUnauthorized, true)
})

// ── what the server actually negotiates ─────────────────────────────────────

test('disabled leaves the connection unencrypted', async t => {
  if (!requireLive(t)) return
  const cipher = await cipherFor(profileWith('disabled'))
  assert.equal(cipher, '', 'no cipher means no TLS')
})

test('required negotiates real TLS', async t => {
  if (!requireLive(t)) return
  const cipher = await cipherFor(profileWith('required'))
  assert.ok(typeof cipher === 'string' && cipher.length > 0, `expected a cipher, got ${JSON.stringify(cipher)}`)
  console.log(`  ↳ required negotiated ${cipher}`)
})

test('an untrusted certificate is refused by verify-ca', async t => {
  if (!requireLive(t)) return
  await assert.rejects(
    () => testProfile(profileWith('verify-ca')),
    error => {
      assert.equal(error.code, 'HANDSHAKE_SSL_ERROR', `verify-ca -> ${error.code}`)
      assert.match(String(error.message), /self-signed|certificate/i)
      return true
    },
    'verify-ca must refuse a self-signed server certificate',
  )
})

test('trusting the server s own CA makes verify-ca succeed', async t => {
  if (!requireLive(t)) return
  if (serverCa === null) {
    t.skip('could not read the server certificate chain')
    return
  }
  console.log(`  ↳ trust anchor CN=${serverCa.leaf} san=${serverCa.san || '(none)'}`)

  const result = await testProfile(profileWith('verify-ca', serverCa.pem))
  assert.equal(result.ok, true)
  assert.equal(typeof result.version, 'string')

  // And the connection is genuinely encrypted, not merely accepted.
  const cipher = await cipherFor(profileWith('verify-ca', serverCa.pem))
  assert.ok(typeof cipher === 'string' && cipher.length > 0)
})

test('the trust anchor the server presents is readable as PEM', async t => {
  if (!requireLive(t)) return
  if (serverCa === null) {
    t.skip('could not read the server certificate chain')
    return
  }
  // Documents WHY the previous test takes the branch it takes on this instance:
  // the auto-generated certificate carries no subjectAltName.
  console.log(`  ↳ anchor CN=${serverCa.leaf} san=${serverCa.san || '(none)'}`)
  assert.equal(typeof serverCa.pem, 'string')
  assert.match(serverCa.pem, /^-----BEGIN CERTIFICATE-----/)
})
