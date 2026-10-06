// Pure spool logic shared by the agent-ticks plugin (hooks/register.ts) and the
// agent-remind CLI (bin/agent-remind). No I/O here: callers read and
// move the files.
//
// Spool: $AGENT_TICKS_DIR/<id>.json (default ~/.local/state/always-on-agent/spool), one item per file, written as
// .<id>.tmp then renamed. Delivered items move to done/, cancelled ones to
// cancelled/, unreadable ones to bad/. The mod claims items by moving them to
// inflight/ before it submits, and moves them back if the submit fails.

export type Kind = 'tick' | 'reminder' | 'urgent'

export type Item = {
  id: string
  text: string
  kind: Kind
  created_at: string
  due_at?: string
  dedupe_key?: string
}

export type Entry = { file: string; item: Item }

export const KINDS: readonly Kind[] = ['tick', 'reminder', 'urgent']

// Seconds without a plugin heartbeat after which `agent-remind --alive` fails.
export const ALIVE_STALE_S = 180

// A file name the spool owns: <id>.json, never a dotfile (temp files).
export function isItemFile(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.')
}

// Sortable, unique enough: 20261002T151230Z-3f9a1c
export function newId(nowMs: number, rand: string): string {
  const t = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `${t}-${rand}`
}

// Parses one file's text; null when it isn't a valid item.
export function parseItem(raw: string): Item | null {
  let v: any
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  if (typeof v.id !== 'string' || !v.id) return null
  if (typeof v.text !== 'string' || !v.text.trim()) return null
  if (!KINDS.includes(v.kind)) return null
  if (typeof v.created_at !== 'string' || Number.isNaN(Date.parse(v.created_at))) return null
  if (v.due_at !== undefined && (typeof v.due_at !== 'string' || Number.isNaN(Date.parse(v.due_at)))) return null
  if (v.dedupe_key !== undefined && typeof v.dedupe_key !== 'string') return null
  const item: Item = { id: v.id, text: v.text, kind: v.kind, created_at: v.created_at }
  if (v.due_at) item.due_at = v.due_at
  if (v.dedupe_key) item.dedupe_key = v.dedupe_key
  return item
}

export function dueMs(item: Item): number {
  return Date.parse(item.due_at ?? item.created_at)
}

// Items due at nowMs (no due_at = due now), oldest due first.
export function selectDue(entries: readonly Entry[], nowMs: number): Entry[] {
  return entries
    .filter((e) => !e.item.due_at || Date.parse(e.item.due_at) <= nowMs)
    .sort((a, b) => dueMs(a.item) - dueMs(b.item) || a.item.id.localeCompare(b.item.id))
}

export type Group = { item: Item; files: string[] }

// One group per dedupe_key (items without one stay single). A group sits where
// its first item was and carries its newest item's text; every file in it is
// delivered (moved to done/) together.
export function collapse(due: readonly Entry[]): Group[] {
  const groups: Group[] = []
  const byKey = new Map<string, Group>()
  for (const e of due) {
    const key = e.item.dedupe_key
    const g = key ? byKey.get(key) : undefined
    if (g) {
      g.files.push(e.file)
      if (e.item.created_at >= g.item.created_at) g.item = e.item
      continue
    }
    const fresh = { item: e.item, files: [e.file] }
    groups.push(fresh)
    if (key) byKey.set(key, fresh)
  }
  return groups
}

// The one prompt for a batch: each group's text on its own line.
export function composeText(groups: readonly Group[]): string {
  return groups.map((g) => g.item.text.trim()).join('\n')
}

// ---------- when parsing (agent-remind) ----------

const UNITS: Record<string, number> = {
  s: 1e3, sec: 1e3, secs: 1e3, second: 1e3, seconds: 1e3,
  m: 6e4, min: 6e4, mins: 6e4, minute: 6e4, minutes: 6e4,
  h: 36e5, hr: 36e5, hrs: 36e5, hour: 36e5, hours: 36e5,
  d: 864e5, day: 864e5, days: 864e5,
  w: 6048e5, week: 6048e5, weeks: 6048e5,
}

// "9am", "9:30pm", "17:30", "noon", "midnight" -> [hour, minute], or null.
function parseClock(s: string): [number, number] | null {
  if (s === 'noon') return [12, 0]
  if (s === 'midnight') return [0, 0]
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (min > 59) return null
  if (m[3]) {
    if (h < 1 || h > 12) return null
    if (m[3] === 'am') h = h === 12 ? 0 : h
    else h = h === 12 ? 12 : h + 12
  } else if (!m[2] || h > 23) {
    // A bare number ("9") is ambiguous; require am/pm or hh:mm.
    return null
  }
  return [h, min]
}

// Parses a reminder time in the machine's local zone. Accepts ISO datetimes,
// "in 2h", "in 1h30m", "in 90 minutes", "tomorrow 9am", "today 17:30",
// "9am" (today, or tomorrow if already past), "noon". Null when unparseable.
export function parseWhen(input: string, nowMs: number): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null

  if (s === 'now') return nowMs

  const rel = /^in (.+)$/.exec(s)
  if (rel) {
    let total = 0
    const rest = rel[1].replace(/\band\b|,/g, ' ').trim()
    const re = /(\d+(?:\.\d+)?)\s*([a-z]+)\s*/gy
    let m: RegExpExecArray | null
    let consumed = 0
    while ((m = re.exec(rest))) {
      const unit = UNITS[m[2]]
      if (!unit) return null
      total += Number(m[1]) * unit
      consumed = re.lastIndex
    }
    if (consumed !== rest.length || total <= 0) return null
    return nowMs + Math.round(total)
  }

  const day = /^(today|tonight|tomorrow)(?: (?:at )?(.+))?$/.exec(s)
  if (day) {
    const clock = day[2] ? parseClock(day[2]) : day[1] === 'tonight' ? [20, 0] as [number, number] : [9, 0] as [number, number]
    if (!clock) return null
    const d = new Date(nowMs)
    if (day[1] === 'tomorrow') d.setDate(d.getDate() + 1)
    d.setHours(clock[0], clock[1], 0, 0)
    return d.getTime()
  }

  const at = /^(?:at )?(.+)$/.exec(s)
  const clock = at ? parseClock(at[1]) : null
  if (clock) {
    const d = new Date(nowMs)
    d.setHours(clock[0], clock[1], 0, 0)
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1)
    return d.getTime()
  }

  // ISO-ish: 2026-10-03T09:00, 2026-10-03 09:00, with or without a zone.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(input.trim().replace(' ', 'T'))
    return Number.isNaN(t) ? null : t
  }
  return null
}
