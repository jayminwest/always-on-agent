// agent-ticks: delivers due items from the on-disk spool ($AGENT_TICKS_DIR,
// default ~/.local/state/always-on-agent/spool) as ONE prompt when the session
// is idle, every 30 s and right after each turn. Duplicates by dedupe_key
// collapse to one line. State lives on disk, so nothing is lost when the
// session restarts or the machine sleeps.
//
// Consumer gate: acts only in an interactive session started with
// AGENT_TICKS_CONSUMER=1 (agent-loop sets it), so a second session that loads
// this plugin never eats the queue.
//
// Each timer cycle writes <spool>/.mod-alive (`agent-remind --alive` reads it).
// It hooks no tool or permission event and never changes a decision.

import { collapse, composeText, isItemFile, parseItem, selectDue, type Entry } from './spool.ts'

const CYCLE_MS = 30_000

let dir = ''
let active = false
let busy = false // a main-loop turn is running
let flushing = false // a claim + submit is in progress

function sub(name: string): string {
  return dir + '/' + name
}

async function mv($, from: string, to: string): Promise<boolean> {
  try {
    // Plain rename: fails (non-zero) when the source is gone, which is what
    // makes a claim safe. Ids are unique, so the target never exists.
    const r = await $.process.run(['/bin/mv', from, to])
    return r.exitCode === 0
  } catch {
    return false
  }
}

async function readSpool($, folder: string): Promise<Entry[]> {
  let names: { name: string; kind: string }[] = []
  try {
    names = await $.fs.list(folder)
  } catch {
    return []
  }
  const out: Entry[] = []
  for (const n of names) {
    if (n.kind !== 'file' || !isItemFile(n.name)) continue
    const path = folder + '/' + n.name
    let raw = ''
    try {
      raw = await $.fs.read(path)
    } catch {
      continue // cancelled or claimed meanwhile
    }
    const item = parseItem(raw)
    if (item) out.push({ file: n.name, item })
    else await mv($, path, sub('bad/') + n.name)
  }
  return out
}

// Items a previous run claimed but never confirmed go back to the queue.
async function recoverInflight($) {
  for (const e of await readSpool($, sub('inflight'))) await mv($, sub('inflight/') + e.file, sub(e.file))
}

async function flush($) {
  if (!active || busy || flushing) return
  flushing = true
  const claimed: string[] = []
  try {
    const due = selectDue(await readSpool($, dir), await $.clock.now())
    if (!due.length) return
    const won: Entry[] = []
    for (const e of due) {
      if (await mv($, sub(e.file), sub('inflight/') + e.file)) {
        claimed.push(e.file)
        won.push(e)
      }
    }
    if (!won.length) return
    // Re-check: a turn may have started while we were claiming.
    if (busy) throw new Error('turn started during claim')
    const groups = collapse(won)
    // Resolves once the turn it starts has begun; Claude Code itself holds it
    // until the session is idle, so this never lands inside a running turn.
    const r = await $.prompt.submit({ text: composeText(groups) })
    // A hook refused the prompt: park the items in bad/ rather than retry forever.
    const dest = r && r.drop ? 'bad/' : 'done/'
    for (const f of claimed.splice(0)) await mv($, sub('inflight/') + f, sub(dest) + f)
    if (r && r.drop) $.ui.log('prompt dropped (' + r.drop + '); ' + won.length + ' item(s) moved to bad/')
    else $.ui.log('delivered ' + won.length + ' item(s) as ' + groups.length + ' line(s)')
  } catch {
    // Submit rejected (or a turn started mid-claim): back to the queue for the next cycle.
    for (const f of claimed) await mv($, sub('inflight/') + f, sub(f))
  } finally {
    flushing = false
  }
}

async function cycle($) {
  if (!active) return
  try {
    await $.fs.write(sub('.mod-alive'), new Date(await $.clock.now()).toISOString() + '\n')
  } catch {}
  await flush($)
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    const consumer = await $.env.get('AGENT_TICKS_CONSUMER')
    const override = await $.env.get('AGENT_TICKS_DIR')
    active = Boolean(e.isInteractive && home && consumer === '1')
    if (active) {
      dir = override || home + '/.local/state/always-on-agent/spool'
      try {
        await $.process.run(['/bin/mkdir', '-p', dir + '/done', dir + '/inflight', dir + '/bad', dir + '/cancelled'])
        await recoverInflight($)
      } catch {}
      $.clock.every(CYCLE_MS, () => {
        void cycle($)
      })
      $.clock.after(5_000, () => {
        void cycle($)
      })
    }
    try {
      await $.command.register({ name: 'ticks', description: 'Show the agent-ticks spool (pending reminders and ticks)' })
    } catch {}
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    busy = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn carries agentId; only the main loop's end means idle.
    if (e.agentId === undefined) {
      busy = false
      if (active) {
        $.clock.after(2_000, () => {
          void flush($)
        })
      }
    }
    return next(e)
  })

  on('command.run', { command: 'ticks' }, async ($, e) => {
    if (!active) return { text: 'inactive in this session (needs an interactive session with AGENT_TICKS_CONSUMER=1)' }
    const now = await $.clock.now()
    const items = await readSpool($, dir)
    if (!items.length) return { text: 'spool empty' + (busy ? ' (turn running)' : '') }
    const lines = items
      .sort((a, b) => (a.item.due_at ?? a.item.created_at).localeCompare(b.item.due_at ?? b.item.created_at))
      .map((x) => {
        const when = x.item.due_at ? new Date(Date.parse(x.item.due_at)).toLocaleString() : 'now'
        const state = !x.item.due_at || Date.parse(x.item.due_at) <= now ? 'due' : 'waiting'
        return x.item.id + '  ' + state + '  ' + when + '  ' + x.item.kind + '  ' + x.item.text
      })
    return { text: lines.join('\n') }
  })
}
