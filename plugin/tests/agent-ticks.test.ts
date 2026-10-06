import { expect, mock, test } from 'claude-code/testing'
import { collapse, composeText, newId, parseItem, parseWhen, selectDue, type Entry, type Item } from '../hooks/spool.ts'

const T0 = Date.parse('2026-10-02T15:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

function item(id: string, over: Partial<Item> = {}): Item {
  return { id, text: '[heartbeat]', kind: 'tick', created_at: iso(T0), ...over }
}
const entry = (i: Item): Entry => ({ file: i.id + '.json', item: i })

// ---------- pure logic ----------

test('parseItem accepts a valid item and rejects junk', async () => {
  expect(parseItem(JSON.stringify(item('a', { due_at: iso(T0), dedupe_key: 'heartbeat' })))?.dedupe_key).toBe('heartbeat')
  expect(parseItem('not json')).toBe(null)
  expect(parseItem(JSON.stringify({ ...item('a'), kind: 'other' }))).toBe(null)
  expect(parseItem(JSON.stringify({ ...item('a'), text: '  ' }))).toBe(null)
  expect(parseItem(JSON.stringify({ ...item('a'), due_at: 'someday' }))).toBe(null)
})

test('selectDue keeps items with no due_at or a past due_at, oldest first', async () => {
  const due = selectDue([
    entry(item('late', { due_at: iso(T0 + 60_000) })),
    entry(item('b', { due_at: iso(T0 - 1000) })),
    entry(item('a', { due_at: iso(T0 - 5000) })),
    entry(item('now', { created_at: iso(T0 - 2000) })),
  ], T0)
  expect(due.map((e) => e.item.id)).toEqual(['a', 'now', 'b'])
})

test('three queued heartbeats collapse into one line', async () => {
  const due = [
    entry(item('h1', { dedupe_key: 'heartbeat', created_at: iso(T0) })),
    entry(item('r1', { kind: 'reminder', text: '[reminder] water the plants', created_at: iso(T0 + 1) })),
    entry(item('h2', { dedupe_key: 'heartbeat', created_at: iso(T0 + 2) })),
    entry(item('h3', { dedupe_key: 'heartbeat', created_at: iso(T0 + 3) })),
  ]
  const groups = collapse(due)
  expect(groups.length).toBe(2)
  expect(groups[0].files).toEqual(['h1.json', 'h2.json', 'h3.json'])
  expect(groups[0].item.id).toBe('h3')
  expect(composeText(groups)).toBe('[heartbeat]\n[reminder] water the plants')
})

test('parseWhen handles relative, day-relative, clock and ISO times', async () => {
  const now = new Date(2026, 9, 2, 15, 0, 0).getTime() // local 15:00
  expect(parseWhen('in 2h', now)).toBe(now + 2 * 3600_000)
  expect(parseWhen('in 1h30m', now)).toBe(now + 90 * 60_000)
  expect(parseWhen('in 90 minutes', now)).toBe(now + 90 * 60_000)
  expect(parseWhen('tomorrow 9am', now)).toBe(new Date(2026, 9, 3, 9, 0).getTime())
  expect(parseWhen('today 17:30', now)).toBe(new Date(2026, 9, 2, 17, 30).getTime())
  expect(parseWhen('9am', now)).toBe(new Date(2026, 9, 3, 9, 0).getTime())
  expect(parseWhen('5pm', now)).toBe(new Date(2026, 9, 2, 17, 0).getTime())
  expect(parseWhen('2026-10-05T08:15:00-07:00', now)).toBe(Date.parse('2026-10-05T15:15:00Z'))
  expect(parseWhen('in 2 parsecs', now)).toBe(null)
  expect(parseWhen('9', now)).toBe(null)
  expect(parseWhen('whenever', now)).toBe(null)
})

test('newId sorts by time', async () => {
  expect(newId(T0, 'aa') < newId(T0 + 1000, 'aa')).toBe(true)
})

// ---------- the mod, over an in-memory spool ----------

const HOME = '/home/test'
const SPOOL = HOME + '/.local/state/always-on-agent/spool'

function harness(on, files: Map<string, string>, consumer = '1') {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME, AGENT_TICKS_CONSUMER: consumer })
  const submitted: string[] = []
  on('session.start', () => ({ cwd: HOME }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => {
    const prefix = e.path + '/'
    const names = [...files.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    return { value: names.map((p) => ({ name: p.slice(prefix.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    const argv = e.argv
    if (argv[0] === '/bin/mv') {
      const [from, to0] = argv.slice(1)
      if (!files.has(from)) return { value: { exitCode: 1, stdout: '', stderr: 'ENOENT' } }
      const to = to0.endsWith('/') ? to0 + from.split('/').pop() : to0
      files.set(to, files.get(from)!)
      files.delete(from)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { clock, submitted }
}

function put(files: Map<string, string>, i: Item) {
  files.set(SPOOL + '/' + i.id + '.json', JSON.stringify(i))
}

test('delivers due items as one prompt and moves them to done/', async ($, on) => {
  const files = new Map<string, string>()
  put(files, item('h1', { dedupe_key: 'heartbeat' }))
  put(files, item('h2', { dedupe_key: 'heartbeat', created_at: iso(T0 + 1) }))
  put(files, item('r1', { kind: 'reminder', text: '[reminder] stretch', due_at: iso(T0 + 3_000) }))
  put(files, item('r2', { kind: 'reminder', text: '[reminder] later', due_at: iso(T0 + 3600_000) }))
  const { clock, submitted } = harness(on, files)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: HOME })
  await clock.advance(5_000)

  expect(submitted).toEqual(['[heartbeat]\n[reminder] stretch'])
  expect(files.has(SPOOL + '/done/h1.json')).toBe(true)
  expect(files.has(SPOOL + '/done/h2.json')).toBe(true)
  expect(files.has(SPOOL + '/done/r1.json')).toBe(true)
  expect(files.has(SPOOL + '/r2.json')).toBe(true)
  expect(files.has(SPOOL + '/.mod-alive')).toBe(true)
})

test('holds items while a turn runs and delivers after it ends', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, submitted } = harness(on, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: HOME })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  put(files, item('h1', { dedupe_key: 'heartbeat' }))
  await clock.advance(60_000)
  expect(submitted).toEqual([])

  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', usage: null })
  await clock.advance(2_000)
  expect(submitted).toEqual(['[heartbeat]'])
})

test('a subagent turn ending does not count as idle', async ($, on) => {
  const files = new Map<string, string>()
  const { clock, submitted } = harness(on, files)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: HOME })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  put(files, item('h1'))
  await $.turn.complete({ turnId: 't1', agentId: 'sub1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: null })
  await clock.advance(31_000)
  expect(submitted).toEqual([])
})

test('does nothing without AGENT_TICKS_CONSUMER=1', async ($, on) => {
  const files = new Map<string, string>()
  put(files, item('h1'))
  const { clock, submitted } = harness(on, files, '')
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: HOME })
  await clock.advance(60_000)
  expect(submitted).toEqual([])
  expect(files.has(SPOOL + '/h1.json')).toBe(true)
})

async function failing($, on, submit) {
  const files = new Map<string, string>()
  put(files, item('h1'))
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME, AGENT_TICKS_CONSUMER: '1' })
  on('session.start', () => ({ cwd: HOME }))
  on('command.register', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', ($, e) => (files.has(e.path) ? { value: files.get(e.path) } : { deny: 'ENOENT' }))
  on('fs.list', ($, e) => ({
    value: [...files.keys()].filter((p) => p.startsWith(e.path + '/') && !p.slice(e.path.length + 1).includes('/'))
      .map((p) => ({ name: p.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', ($, e) => {
    if (e.argv[0] === '/bin/mv') {
      const [from, to0] = e.argv.slice(1)
      const to = to0.endsWith('/') ? to0 + from.split('/').pop() : to0
      files.set(to, files.get(from)!)
      files.delete(from)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', submit)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: HOME })
  await clock.advance(5_000)
  expect(files.has(SPOOL + '/done/h1.json')).toBe(false)
  return files
}

test('a rejected submit puts the items back in the queue', async ($, on) => {
  const files = await failing($, on, () => ({ deny: 'rejected in test' }))
  expect(files.has(SPOOL + '/h1.json')).toBe(true)
})

test('a dropped prompt parks the items in bad/', async ($, on) => {
  const files = await failing($, on, () => ({ drop: 'refused in test' }))
  expect(files.has(SPOOL + '/bad/h1.json')).toBe(true)
})
