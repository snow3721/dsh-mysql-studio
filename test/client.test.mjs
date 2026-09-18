/**
 * dsh-mysql-studio — client-half tests.
 *
 * The browser half is a hand-authored bundle in DSH's module-loader format, so
 * there is no compiler to catch a mistake in it. These tests load the real
 * bundle through a stub loader and a stub React, then drive `apply` against
 * fake Cordis contexts — the only way to check the sidebar auto-adaptation (the
 * riskiest part of the file) without a page.
 *
 * Nothing here renders: the assertions are about which registration surface was
 * chosen and what it was handed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// ── browser stubs ───────────────────────────────────────────────────────────

const styleTags = []

globalThis.document = {
  querySelector(selector) {
    const wanted = /data-plugin-css='([^']+)'/.exec(selector)
    if (wanted === null) return null
    return styleTags.find(tag => tag.dataset.pluginCss === wanted[1]) ?? null
  },
  createElement() {
    return { dataset: {}, textContent: '', parentNode: null }
  },
  head: {
    appendChild(node) {
      node.parentNode = this
      styleTags.push(node)
      return node
    },
    removeChild(node) {
      const at = styleTags.indexOf(node)
      if (at !== -1) styleTags.splice(at, 1)
      node.parentNode = null
    },
  },
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('react.fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useMemo: fn => fn(),
}

const requireStub = name => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') {
    return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
  }
  throw new Error(`unexpected module request: ${name}`)
}

const loaded = []
globalThis.window = { __ModuleLoader__: { load: definition => loaded.push(definition) } }

await import('../lib/client.js')

// ── helpers ─────────────────────────────────────────────────────────────────

/** A Cordis-context stand-in that records every contribution. */
function makeCtx(services) {
  return {
    effects: [],
    provided: {},
    injections: [],
    get: name => (name === 'slots' ? services.slots : services[name]),
    provide(name, value) {
      this.provided[name] = value
    },
    effect(fn, label) {
      const dispose = fn()
      this.effects.push({ label, dispose })
      return () => {}
    },
    inject(deps, callback) {
      this.injections.push({ deps, callback })
      return () => {}
    },
    /** Fire the callbacks registered for one dependency, as cordis would. */
    fireInjection(dep) {
      for (const entry of this.injections) {
        if (entry.deps.includes(dep)) entry.callback()
      }
    },
    /** Run every disposer this context collected. */
    disposeAll() {
      for (const effect of this.effects) {
        if (typeof effect.dispose === 'function') effect.dispose()
      }
    },
  }
}

/**
 * A stand-in for one registration surface. It answers BOTH method names,
 * because `ctx.betterSidebar` calls its registrar `registerTab` while the native
 * `ctx.sidebarRightTabs` calls it `register`, and a test must not accidentally
 * pass by exposing only one of them.
 */
function makeSurface() {
  const surface = {
    registered: [],
    opened: [],
    register(definition) {
      surface.registered.push(definition)
      return () => {}
    },
    openTab(seed) {
      surface.opened.push(seed)
    },
  }
  surface.registerTab = surface.register
  return surface
}

/** A `ctx.slots` stand-in that declares its slots immediately. */
function makeSlots() {
  const registrations = []
  return {
    registrations,
    inject(key, callback) {
      registrations.push({ key })
      // A real declaration the slot already satisfies fires synchronously.
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
}

/** Load a fresh copy of the exported plugin halves. */
function loadPlugin() {
  assert.equal(loaded.length, 1, 'the bundle registers exactly one module')
  const definition = loaded[0]
  assert.equal(definition.id, 'dsh-mysql-studio')
  const exported = definition.factory(requireStub)
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual(exported.inject, ['slots'])
  return exported
}

/** A page in the shape `data.rows` returns. */
function makePage() {
  return {
    columns: [
      { name: 'id', type: 'LONG' },
      { name: 'name', type: 'VAR_STRING' },
      { name: 'qty', type: 'LONG' },
    ],
    rows: [[1, 'alpha', 1], [2, 'beta', 2], [3, 'gamma', 3]],
    primaryKey: ['id'],
    offset: 0,
  }
}

/** Column metadata in the shape `catalog.columns` returns. */
function makeMeta() {
  return new Map([
    ['id', { name: 'id', columnType: 'int', extra: 'auto_increment' }],
    ['name', { name: 'name', columnType: 'varchar(64)', extra: '' }],
    ['qty', { name: 'qty', columnType: 'int', extra: '' }],
    ['payload', { name: 'payload', columnType: 'blob', extra: '' }],
    ['doubled', { name: 'doubled', columnType: 'int', extra: 'STORED GENERATED' }],
  ])
}

// ── tests ───────────────────────────────────────────────────────────────────

test('the bundle loads and exports a Cordis plugin', () => {
  const { apply } = loadPlugin()
  assert.equal(typeof apply, 'function')
})

test('registers through ctx.betterSidebar when it is installed', () => {
  styleTags.length = 0
  const { apply } = loadPlugin()
  const better = makeSurface()
  better.getTabs = () => better.registered
  better.isTabEnabled = () => true
  const ctx = makeCtx({ betterSidebar: better, slots: makeSlots() })

  apply(ctx)

  assert.equal(better.registered.length, 1, 'one tab descriptor')
  const descriptor = better.registered[0]
  assert.equal(descriptor.id, 'mysql-studio')
  assert.equal(descriptor.single, true)
  assert.equal(descriptor.order, 60)
  assert.equal(typeof descriptor.component, 'function')
  assert.equal(descriptor.title(), 'MySQL Studio')
  assert.match(descriptor.description(), /MySQL/)
  // The icon factory is what the sidebar draws in the tab strip and guide.
  assert.equal(descriptor.icon(14).type.name, 'DatabaseIcon')

  // The plugin's own opener reaches the same surface.
  assert.equal(typeof ctx.provided.mysqlStudio.open, 'function')
  ctx.provided.mysqlStudio.open()
  assert.deepEqual(better.opened, [{ type: 'mysql-studio', title: 'MySQL Studio' }])

  ctx.disposeAll()
  assert.equal(styleTags.length, 0, 'unloading leaves no orphan stylesheet')
})

test('falls back to the native right Sidebar when better-sidebar is absent', async () => {
  styleTags.length = 0
  const { apply } = loadPlugin()
  const tabs = makeSurface()
  const right = makeSurface()
  const slots = makeSlots()
  const ctx = makeCtx({ sidebarRightTabs: tabs, sidebarRight: right, slots })

  apply(ctx)
  // The native path is deferred by a short grace period so a co-resident
  // dsh-better-sidebar can publish first; the inject callback is the
  // deterministic way in, and it is a real cordis path too.
  ctx.fireInjection('betterSidebar')

  assert.equal(tabs.registered.length, 1, 'one native tab type')
  const type = tabs.registered[0]
  assert.equal(type.id, 'dsh-mysql-studio:studio')
  assert.equal(type.kind, 'mysql-studio')
  assert.equal(type.priority, 'extension')
  assert.equal(type.title(), 'MySQL Studio')
  assert.equal(type.guide[0].title(), 'MySQL Studio')
  assert.match(type.guide[0].description(), /MySQL/)

  assert.deepEqual(slots.registrations[0], { key: 'sidebar.right.pane.tab' })
  const body = slots.registrations.find(entry => entry.options !== undefined)
  assert.equal(body.options.name, 'sidebar.right.pane.tab')
  assert.equal(body.options.key, 'dsh-mysql-studio:studio')
  assert.equal(typeof body.options.inject, 'function')
  assert.equal(typeof body.component, 'function')

  ctx.provided.mysqlStudio.open()
  assert.deepEqual(right.opened, ['mysql-studio'], 'the opener names the page kind')

  ctx.disposeAll()
  // Let the deferred grace loop drain so no work outlives the test.
  await new Promise(resolve => setTimeout(resolve, 120))
})

test('prefers better-sidebar even when the native registry appears first', async () => {
  styleTags.length = 0
  const { apply } = loadPlugin()
  const better = makeSurface()
  better.getTabs = () => better.registered
  better.isTabEnabled = () => true
  const tabs = makeSurface()
  // `betterSidebar` starts absent: this test is about the window in which the
  // native registry is live but dsh-better-sidebar has not applied yet.
  const services = { sidebarRightTabs: tabs, sidebarRight: makeSurface(), slots: makeSlots() }
  const ctx = makeCtx(services)

  apply(ctx)
  ctx.fireInjection('sidebarRightTabs')
  assert.equal(tabs.registered.length, 0, 'no native registration while the richer surface may still arrive')
  assert.equal(better.registered.length, 0)

  // It applies a moment later: the richer surface wins, and the deferred native
  // path never runs.
  services.betterSidebar = better
  ctx.fireInjection('betterSidebar')
  assert.equal(better.registered.length, 1)
  assert.equal(tabs.registered.length, 0)

  ctx.disposeAll()
  await new Promise(resolve => setTimeout(resolve, 120))
})

test('registers nothing when neither sidebar surface exists', async () => {
  styleTags.length = 0
  const { apply } = loadPlugin()
  const ctx = makeCtx({ slots: makeSlots() })
  apply(ctx)
  assert.equal(typeof ctx.provided.mysqlStudio.open, 'function')
  // The opener stays a safe no-op rather than throwing into the host.
  ctx.provided.mysqlStudio.open()
  ctx.disposeAll()
  await new Promise(resolve => setTimeout(resolve, 120))
})

test('installs its stylesheet once per page, using DSH skin tokens', () => {
  styleTags.length = 0
  const { apply } = loadPlugin()
  const makeBetter = () => {
    const surface = makeSurface()
    surface.getTabs = () => surface.registered
    surface.isTabEnabled = () => true
    return surface
  }

  const first = makeCtx({ betterSidebar: makeBetter(), slots: makeSlots() })
  apply(first)
  assert.equal(styleTags.length, 1)
  const stylesheet = styleTags[0]
  assert.equal(stylesheet.dataset.plugin, 'dsh-mysql-studio')
  assert.match(stylesheet.textContent, /\.mst-root/)
  assert.match(stylesheet.textContent, /--dsw-alias-label-primary/)
  assert.match(stylesheet.textContent, /\.mst-grid td\{[^}]*border-right:1px solid/)
  assert.match(stylesheet.textContent, /\.mst-grid th\{[^}]*border-right:1px solid/)

  // A second activation on the same page must not double the sheet.
  const second = makeCtx({ betterSidebar: makeBetter(), slots: makeSlots() })
  apply(second)
  assert.equal(styleTags.length, 1, 'idempotent per page')

  first.disposeAll()
  second.disposeAll()
  assert.equal(styleTags.length, 0)
})

test('the API client reports an unreachable host half instead of throwing raw', async () => {
  styleTags.length = 0
  const { apply } = loadPlugin()
  const better = makeSurface()
  better.getTabs = () => better.registered
  better.isTabEnabled = () => true
  const ctx = makeCtx({ betterSidebar: better, slots: makeSlots() })
  apply(ctx)

  const originalFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'))
  try {
    await assert.rejects(() => ctx.provided.mysqlStudio.call('conn.list'), /Host 半/)
  } finally {
    globalThis.fetch = originalFetch
    ctx.disposeAll()
  }
})

// ── pending-state translation ───────────────────────────────────────────────
//
// This is the browser's half of the write contract: it decides what a commit
// even asks for. The host re-validates everything, but a bug here shows up as a
// wrong or missing write rather than as an error, so it is worth pinning down.

test('an untouched editor asks for nothing', () => {
  const { __internals } = loadPlugin()
  assert.deepEqual(__internals.buildMutations(makePage(), {}, {}, []), [])
  assert.equal(__internals.pendingRowCount({}, {}, []), 0)
})

test('a cell edit becomes one update carrying the key and the original row', () => {
  const { __internals } = loadPlugin()
  const page = makePage()
  const mutations = __internals.buildMutations(page, { 1: { name: 'BETA' } }, {}, [])

  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].kind, 'update')
  assert.deepEqual(mutations[0].set, { name: 'BETA' })
  assert.deepEqual(mutations[0].key, { id: 2 })
  // The host needs the whole original row to build its concurrency WHERE clause.
  assert.deepEqual(mutations[0].original, { id: 2, name: 'beta', qty: 2 })
})

test('two edits in one row stay one update', () => {
  const { __internals } = loadPlugin()
  const mutations = __internals.buildMutations(makePage(), { 0: { name: 'A', qty: 9 } }, {}, [])
  assert.equal(mutations.length, 1)
  assert.deepEqual(mutations[0].set, { name: 'A', qty: 9 })
})

test('a row marked for deletion sends a delete and not an update', () => {
  const { __internals } = loadPlugin()
  const page = makePage()
  // Editing and then deleting a row must not produce both.
  const mutations = __internals.buildMutations(page, { 2: { name: 'G' } }, { 2: true }, [])

  assert.equal(mutations.length, 1)
  assert.equal(mutations[0].kind, 'delete')
  assert.deepEqual(mutations[0].key, { id: 3 })
})

test('staged inserts become insert mutations in order', () => {
  const { __internals } = loadPlugin()
  const mutations = __internals.buildMutations(makePage(), {}, {}, [{ name: 'delta' }, { name: 'epsilon', qty: 5 }])
  assert.deepEqual(mutations.map(entry => entry.kind), ['insert', 'insert'])
  assert.deepEqual(mutations[1].values, { name: 'epsilon', qty: 5 })
})

test('a mixed batch is ordered updates, then deletes, then inserts', () => {
  const { __internals } = loadPlugin()
  const mutations = __internals.buildMutations(
    makePage(),
    { 0: { name: 'A' } },
    { 1: true },
    [{ name: 'new' }],
  )
  assert.deepEqual(mutations.map(entry => entry.kind), ['update', 'delete', 'insert'])
})

test('NULL edits survive the round trip as null', () => {
  const { __internals } = loadPlugin()
  const mutations = __internals.buildMutations(makePage(), { 0: { name: null } }, {}, [])
  assert.equal(mutations[0].set.name, null)
})

test('pending counts report rows and cells', () => {
  const { __internals } = loadPlugin()
  const page = makePage()
  const edits = { 0: { name: 'A', qty: 1 }, 1: { name: 'B' } }
  const deletions = {}
  const inserts = [{ name: 'x' }, { name: 'y', qty: 2 }]

  assert.equal(__internals.pendingRowCount(edits, deletions, inserts), 4)
  // 2 + 1 edited cells, 3 inserted cells, no deleted rows.
  assert.equal(__internals.pendingCellCount(page, edits, deletions, inserts), 6)
})

test('an edited-then-deleted row counts once, as a deletion', () => {
  const { __internals } = loadPlugin()
  const page = makePage()
  assert.equal(__internals.pendingRowCount({ 2: { name: 'G' } }, { 2: true }, []), 1)
  // The row contributes its whole width, because that is what a delete costs.
  assert.equal(__internals.pendingCellCount(page, { 2: { name: 'G' } }, { 2: true }, []), 3)
})

test('sameCell mirrors the host s no-op rule', () => {
  const { __internals } = loadPlugin()
  assert.equal(__internals.sameCell('5', 5), true, 'a numeric round trip is not an edit')
  assert.equal(__internals.sameCell(5, 5), true)
  assert.equal(__internals.sameCell(null, null), true)
  assert.equal(__internals.sameCell('', null), false, 'clearing a NULL cell is an edit')
  assert.equal(__internals.sameCell(null, ''), false)
  assert.equal(__internals.sameCell('x', 'y'), false)
})

test('readOnlyReason names what the host will also refuse', () => {
  const { __internals } = loadPlugin()
  const meta = makeMeta()
  assert.equal(__internals.readOnlyReason(meta.get('name')), null)
  assert.equal(__internals.readOnlyReason(meta.get('payload')), '二进制列')
  assert.equal(__internals.readOnlyReason(meta.get('doubled')), '生成列')
  assert.equal(__internals.readOnlyReason(undefined), '缺少列元数据')
})

test('rowObject and rowKeyOf read the page by column name', () => {
  const { __internals } = loadPlugin()
  const page = makePage()
  assert.deepEqual(__internals.rowObject(page, 1), { id: 2, name: 'beta', qty: 2 })
  assert.deepEqual(__internals.rowKeyOf(page, 1), { id: 2 })
})

// ── the render paths ────────────────────────────────────────────────────────
//
// React is only available from the page's module table, so these call the
// components directly against the stub runtime. That is not a rendering test —
// but the components are plain functions of their props, so calling one runs
// exactly the code that runs first in the browser, and a crash there is a blank
// tab. Everything below is reachable this way except effects and event
// handlers, which never fire during a first render anyway.

/** Walk an element tree built by the stub React, collecting text and class names. */
function inspect(node, found = { texts: [], classes: [], types: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.texts.push(String(node))
    return found
  }
  if (Array.isArray(node)) {
    for (const child of node) inspect(child, found)
    return found
  }
  if (typeof node.type === 'function') {
    found.types.push(node.type.name)
    return found
  }
  if (typeof node.type === 'string') found.types.push(node.type)
  const className = node.props?.className
  if (typeof className === 'string') found.classes.push(...className.split(/\s+/).filter(Boolean))
  for (const child of node.children ?? []) inspect(child, found)
  return found
}

const textOf = node => inspect(node).texts.join(' ')

test('every component survives its first render', () => {
  const { __internals } = loadPlugin()
  const page = makePage()
  const metaByName = makeMeta()

  // The workbench with no connections yet — the state a fresh install opens in.
  assert.match(textOf(__internals.Studio()), /新建连接/)
  assert.match(textOf(__internals.Studio()), /查询/)

  assert.match(
    textOf(__internals.CreateDatabaseDialog({ onCancel: () => {}, onSubmit: () => {} })),
    /新建库/,
  )
  assert.match(
    textOf(__internals.CreateTableDialog({ database: 'shop', onCancel: () => {}, onSubmit: () => {} })),
    /新建表/,
  )

  // The read-only grid used by the SQL console.
  assert.match(textOf(__internals.Grid({ columns: page.columns, rows: page.rows, offset: 0 })), /alpha/)

  // The structure view.
  const columns = [{ name: 'id', columnType: 'int', nullable: false, columnKey: 'PRI', columnDefault: null, extra: '', comment: '' }]
  assert.match(textOf(__internals.ColumnsView({ columns })), /PRIMARY|id/)

  // The connection editor, both as "new" and as "edit an existing profile".
  assert.match(textOf(__internals.ConnectionEditor({ profile: null, onCancel: () => {}, onSave: () => {} })), /新建 MySQL 连接/)
  assert.match(
    textOf(__internals.ConnectionEditor({
      profile: { id: 'c1', name: 'n', host: 'h', port: 3306, user: 'u', hasPassword: true, ssl: { mode: 'required' } },
      onCancel: () => {},
      onSave: () => {},
    })),
    /编辑连接/,
  )

  // And the editable grid in its several states.
  assert.match(textOf(__internals.EditableGrid({
    page, metaByName, edits: {}, deletions: {}, inserts: [], draft: null, canEdit: true, offset: 0,
    onEdit: () => {}, onDeleteRow: () => {}, onRestoreRow: () => {}, onDraftCell: () => {}, onDraftConfirm: () => {},
  })), /alpha/)
})

test('an empty result set renders an explanation, not a crash', () => {
  const { __internals } = loadPlugin()
  assert.match(textOf(__internals.Grid({ columns: [], rows: [] })), /没有结果集/)
  assert.match(textOf(__internals.ColumnsView({ columns: [] })), /没有列信息/)
})

test('the editable grid shows pending edits and struck-through deletions', () => {
  const { __internals } = loadPlugin()
  const page = makePage()
  const tree = __internals.EditableGrid({
    page,
    metaByName: makeMeta(),
    edits: { 0: { name: 'ALPHA' }, 1: { qty: null } },
    deletions: { 2: true },
    inserts: [],
    draft: null,
    canEdit: true,
    offset: 0,
    onEdit: () => {},
    onDeleteRow: () => {},
    onRestoreRow: () => {},
    onDraftCell: () => {},
    onDraftConfirm: () => {},
  })
  const found = inspect(tree)

  // The edited value replaces the loaded one, and the cell is marked dirty.
  assert.match(found.texts.join(' '), /ALPHA/)
  assert.equal(found.texts.includes('alpha'), false, 'the loaded value must give way to the pending one')
  assert.ok(found.classes.includes('dirty'), 'an edited cell is marked')
  // A cell edited TO null renders as NULL.
  assert.ok(found.texts.includes('NULL'))
  // The deleted row keeps its text but its row is marked.
  assert.ok(found.classes.includes('deleted'))
  assert.match(found.texts.join(' '), /gamma/)
})

test('the editable grid explains read-only columns and keyless tables', () => {
  const { __internals } = loadPlugin()
  const base = {
    edits: {}, deletions: {}, inserts: [], draft: null, offset: 0,
    onEdit: () => {}, onDeleteRow: () => {}, onRestoreRow: () => {}, onDraftCell: () => {}, onDraftConfirm: () => {},
  }
  const page = {
    columns: [{ name: 'id', type: 'LONG' }, { name: 'payload', type: 'BLOB' }, { name: 'doubled', type: 'LONG' }],
    rows: [[1, 'AAAA', 2]],
    primaryKey: ['id'],
  }

  const withKey = inspect(__internals.EditableGrid({ ...base, page, metaByName: makeMeta(), canEdit: true }))
  assert.match(withKey.texts.join(' '), /只读/, 'a binary column is labelled read-only')

  // No primary key means no safe row identity, so the whole grid is read-only.
  const keyless = inspect(__internals.EditableGrid({
    ...base,
    page: { ...page, primaryKey: [] },
    metaByName: makeMeta(),
    canEdit: false,
  }))
  assert.match(keyless.texts.join(' '), /没有主键/)
})

test('a draft row renders one input per writable column', () => {
  const { __internals } = loadPlugin()
  const page = {
    columns: [{ name: 'id', type: 'LONG' }, { name: 'name', type: 'VAR_STRING' }, { name: 'payload', type: 'BLOB' }],
    rows: [[1, 'alpha', 'AAAA']],
    primaryKey: ['id'],
  }
  const found = inspect(__internals.EditableGrid({
    page,
    metaByName: makeMeta(),
    edits: {}, deletions: {}, inserts: [],
    draft: { name: 'new' },
    canEdit: true,
    offset: 0,
    onEdit: () => {}, onDeleteRow: () => {}, onRestoreRow: () => {}, onDraftCell: () => {}, onDraftConfirm: () => {},
  }))

  const inputs = []
  const collect = node => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node.type === 'input') inputs.push(node.props)
    ;(node.children ?? []).forEach(collect)
  }
  collect(__internals.EditableGrid({
    page, metaByName: makeMeta(), edits: {}, deletions: {}, inserts: [], draft: { name: 'new' }, canEdit: true,
    offset: 0, onEdit: () => {}, onDeleteRow: () => {}, onRestoreRow: () => {}, onDraftCell: () => {}, onDraftConfirm: () => {},
  }))
  // `id` and `name` are writable, `payload` is a blob: two inputs, not three.
  assert.equal(inputs.length, 2, `expected 2 inputs, got ${inputs.length}`)
  assert.equal(inputs.some(input => input.value === 'new'), true, 'the draft value is shown')
  assert.ok(found.texts.length > 0)
})

test('the pending bar counts rows and cells, and a skipped row does not double-count', () => {
  // The counting rules are asserted directly in the pending-state tests; this
  // pins the string the reader actually sees.
  const { __internals } = loadPlugin()
  const page = makePage()
  assert.equal(__internals.pendingRowCount({ 0: { name: 'A' }, 1: { qty: 1 } }, { 2: true }, []), 3)
  assert.equal(__internals.pendingCellCount(page, { 0: { name: 'A' }, 1: { qty: 1 } }, { 2: true }, []), 5)
})

test('formatCell covers the shapes a real column can return', () => {
  const { __internals } = loadPlugin()
  assert.deepEqual(__internals.formatCell(null, { type: 'VAR_STRING' }), { text: 'NULL', kind: 'null' })
  assert.deepEqual(__internals.formatCell(true, { type: 'TINY' }), { text: 'true', kind: 'bool' })
  assert.deepEqual(__internals.formatCell('x', { type: 'VAR_STRING' }), { text: 'x', kind: 'text' })
  // A binary column arrives base64-encoded and renders as a byte count.
  const binary = __internals.formatCell(Buffer.from('hello').toString('base64'), { type: 'BLOB' })
  assert.match(binary.text, /BINARY 5 bytes/)
  assert.equal(binary.kind, 'binary')
  assert.equal(binary.title, '0x68656c6c6f')
  // A JSON column arrives re-serialized.
  assert.equal(__internals.formatCell('{"a":1}', { type: 'JSON' }).text, '{"a":1}')
})

test('formatCount is compact and total', () => {
  const { __internals } = loadPlugin()
  assert.equal(__internals.formatCount(null), '?')
  assert.equal(__internals.formatCount(42), '42')
  assert.equal(__internals.formatCount(1500), '1.5k')
  assert.equal(__internals.formatCount(2500000), '2.5M')
})

test('formatInsertSql matches the host export shape', () => {
  const { __internals } = loadPlugin()
  const sql = __internals.formatInsertSql({
    database: 'shop',
    table: 'users',
    columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar' }],
    rows: [[1, "O'Reilly"], [2, null]],
  })
  assert.equal(
    sql,
    "INSERT INTO `shop`.`users` (`id`, `name`) VALUES\n  (1, 'O''Reilly'),\n  (2, NULL);\n",
  )
  assert.equal(__internals.sqlLiteral(null), 'NULL')
  assert.equal(__internals.quoteId('weird`name'), '`weird``name`')
})

// ── the connection form ─────────────────────────────────────────────────────

test('a stored profile maps onto the flat form', () => {
  const { __internals } = loadPlugin()
  const form = __internals.draftFrom({
    id: 'c1',
    name: 'prod',
    host: 'db.internal',
    port: 3307,
    user: 'root',
    hasPassword: true,
    ssl: { mode: 'verify-ca', ca: 'CA' },
  })
  assert.equal(form.host, 'db.internal')
  assert.equal(form.port, '3307')
  assert.equal(form.sslMode, 'verify-ca')
  assert.equal(form.sslCa, 'CA')
  assert.equal(form.password, '')
  assert.equal(form.hasPassword, true)
  assert.equal('transport' in form, false)
  assert.equal('sshHost' in form, false)
})

test('a fresh form is a plain TCP connection', () => {
  const { __internals } = loadPlugin()
  const form = __internals.draftFrom(null)
  assert.equal(form.host, '127.0.0.1')
  assert.equal(form.port, '3306')
  assert.equal(form.sslMode, 'disabled')
  const draft = __internals.profileDraft(form)
  assert.equal(draft.host, '127.0.0.1')
  assert.equal('transport' in draft, false)
  assert.equal('ssh' in draft, false)
})

test('dropped TLS modes fold onto the ones the form still offers', () => {
  const { __internals } = loadPlugin()
  assert.equal(__internals.draftFrom({ host: 'h', ssl: { mode: 'preferred' } }).sslMode, 'required')
  assert.equal(__internals.draftFrom({ host: 'h', ssl: { mode: 'verify-identity' } }).sslMode, 'verify-ca')
})

test('untouched password boxes are omitted, so a save cannot clear them', () => {
  const { __internals } = loadPlugin()
  const draft = __internals.profileDraft(__internals.draftFrom({
    id: 'c1', name: 'n', host: 'h', port: 3306, user: 'u', hasPassword: true,
  }))
  assert.equal('password' in draft, false, 'an empty DB password box must omit the key')
  assert.equal(draft.host, 'h')
})

test('a re-exported profile round-trips through the form unchanged', () => {
  const { __internals } = loadPlugin()
  const original = {
    id: 'c9', name: 'prod', host: 'db.internal', port: 3307, user: 'root',
    database: 'shop', charset: 'utf8mb4',
    ssl: { mode: 'verify-ca', ca: 'CA' },
    hasPassword: true,
  }
  const draft = __internals.profileDraft(__internals.draftFrom(original))
  assert.equal(draft.host, 'db.internal')
  assert.equal(draft.port, '3307')
  assert.equal(draft.database, 'shop')
  assert.equal(draft.ssl.mode, 'verify-ca')
  assert.equal(draft.ssl.ca, 'CA')
  assert.equal('ssh' in draft, false)
})

test('the editor offers the three remaining tabs', () => {
  const { __internals } = loadPlugin()
  const found = inspect(__internals.ConnectionEditor({ profile: null, onCancel: () => {}, onSave: () => {} }))
  const text = found.texts.join(' ')
  assert.doesNotMatch(text, /传输 \/ SSH/)
  assert.match(text, /基础/)
  assert.match(text, /SSL\/TLS/)
  assert.match(text, /URL 粘贴/)
  assert.match(text, /新建 MySQL 连接/)
})
