import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { KnowledgeChunk } from '../knowledge/search'
import type { ConversationKind } from '../memory/conversation-key'
import type { BubbleSide } from '../memory/transcript-merge'
import { coerceAgent, defaultAgents, type AgentProfile } from './agents'
import type { ShiftEvent } from './report'

export interface ColdEntry {
  key: string
  title: string
  kind: ConversationKind
  note: string
  createdAt: number
}

export interface TurnRow {
  side: BubbleSide
  text: string
  at: number
  source: 'vision' | 'sent' | 'human'
}

export class ShiftStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        json TEXT NOT NULL,
        enabled INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        conv_key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        side TEXT NOT NULL,
        text TEXT NOT NULL,
        at INTEGER NOT NULL,
        source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conv_state (
        conv_key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        handed_off INTEGER NOT NULL DEFAULT 0,
        bad_count INTEGER NOT NULL DEFAULT 0,
        resumed_at INTEGER NOT NULL DEFAULT 0,
        handled_inbound TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        conv_key TEXT NOT NULL,
        title TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cold_list (
        conv_key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL
      );
    `)
    this.ensureColumn('conv_state', 'resumed_at', 'ALTER TABLE conv_state ADD COLUMN resumed_at INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn(
      'conv_state',
      'handled_inbound',
      "ALTER TABLE conv_state ADD COLUMN handled_inbound TEXT NOT NULL DEFAULT ''"
    )
  }

  private ensureColumn(table: string, column: string, statement: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some((item) => item.name === column)) return
    this.db.exec(statement)
  }

  static open(filePath: string): ShiftStore {
    mkdirSync(path.dirname(filePath), { recursive: true })
    return new ShiftStore(new DatabaseSync(filePath))
  }

  static memory(): ShiftStore {
    return new ShiftStore(new DatabaseSync(':memory:'))
  }

  seedAgents(existingPrompt = ''): void {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }
    if (row.n > 0) return
    defaultAgents(existingPrompt).forEach((agent, index) => {
      this.insertAgent(agent, index, index === 0)
    })
  }

  listAgents(): AgentProfile[] {
    this.seedAgents()
    const rows = this.db.prepare('SELECT json FROM agents ORDER BY position ASC').all() as Array<{ json: string }>
    const fallback = defaultAgents()
    return rows.map((row, index) => coerceAgent(JSON.parse(row.json), fallback[index] ?? fallback[0]))
  }

  saveAgent(agent: AgentProfile, preserveMode = true): void {
    const current = this.listAgents()
    const fallback = current.find((item) => item.id === agent.id) ?? defaultAgents()[0]
    const next = coerceAgent(agent, fallback)
    if (preserveMode) next.mode = fallback.mode
    const row = this.db.prepare('SELECT position, enabled FROM agents WHERE id = ?').get(next.id) as
      | { position: number; enabled: number }
      | undefined
    const position = row?.position ?? current.length
    const enabled = row?.enabled ?? 0
    this.db.prepare('INSERT INTO agents (id, position, json, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(
      next.id,
      position,
      JSON.stringify(next),
      enabled
    )
  }

  enableAgent(id: string): void {
    this.db.prepare('UPDATE agents SET enabled = 0').run()
    this.db.prepare('UPDATE agents SET enabled = 1 WHERE id = ?').run(id)
  }

  createAgent(): { ok: true; id: string } {
    this.seedAgents()
    const base = defaultAgents()[0]
    const created: AgentProfile = {
      ...base,
      id: `custom-${randomUUID()}`,
      name: '未命名岗位',
      template: 'custom',
      mode: 'assist',
      materialRules: []
    }
    this.insertAgent(created, this.nextPosition(), false)
    return { ok: true, id: created.id }
  }

  copyAgent(id: string): { ok: boolean; message?: string; id?: string } {
    this.seedAgents()
    const source = this.listAgents().find((item) => item.id === id)
    if (!source) return { ok: false, message: '没有这个智能体' }
    const copy: AgentProfile = {
      ...source,
      id: `custom-${randomUUID()}`,
      name: `${source.name} 副本`,
      template: 'custom',
      mode: 'assist'
    }
    this.insertAgent(copy, this.nextPosition(), false)
    this.copyKnowledge(id, copy.id)
    return { ok: true, id: copy.id }
  }

  disableAgent(id: string): { ok: boolean; message?: string } {
    const row = this.db.prepare('SELECT enabled FROM agents WHERE id = ?').get(id) as { enabled: number } | undefined
    if (!row) return { ok: false, message: '没有这个智能体' }
    if (row.enabled !== 1) return { ok: true }
    const next = this.db.prepare('SELECT id FROM agents WHERE id != ? ORDER BY position ASC LIMIT 1').get(id) as
      | { id: string }
      | undefined
    if (!next) return { ok: false, message: '先启用另一个岗位' }
    this.enableAgent(next.id)
    return { ok: true }
  }

  /** 删除岗位和它的知识包。不删会话记录。 */
  deleteAgent(id: string): { ok: boolean; message?: string } {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }
    if (count.n <= 1) return { ok: false, message: '至少留一个智能体' }
    const row = this.db.prepare('SELECT enabled FROM agents WHERE id = ?').get(id) as { enabled: number } | undefined
    if (!row) return { ok: false, message: '没有这个智能体' }
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM knowledge WHERE pack_id = ?').run(id)
    if (row.enabled === 1) {
      const next = this.db.prepare('SELECT id FROM agents ORDER BY position ASC LIMIT 1').get() as { id: string } | undefined
      if (next) this.enableAgent(next.id)
    }
    return { ok: true }
  }

  activeAgent(): AgentProfile {
    this.seedAgents()
    const row = this.db.prepare('SELECT json FROM agents WHERE enabled = 1 ORDER BY position ASC LIMIT 1').get() as
      | { json: string }
      | undefined
    const fallback = defaultAgents()[0]
    if (!row) return fallback
    return coerceAgent(JSON.parse(row.json), fallback)
  }

  listTurns(key: string): TurnRow[] {
    const rows = this.db
      .prepare('SELECT side, text, at, source FROM turns WHERE conv_key = ? ORDER BY at ASC, rowid ASC')
      .all(key) as unknown as TurnRow[]
    return rows
  }

  clearTurns(key: string): void {
    this.db.prepare('DELETE FROM turns WHERE conv_key = ?').run(key)
  }

  appendTurns(
    key: string,
    title: string,
    kind: ConversationKind,
    bubbles: Array<{ side: BubbleSide; text: string }>,
    source: TurnRow['source']
  ): void {
    if (bubbles.length === 0) return
    this.ensureConv(key, title, kind)
    const insert = this.db.prepare(
      'INSERT INTO turns (id, conv_key, title, kind, side, text, at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const now = Date.now()
    bubbles.forEach((bubble, index) => {
      insert.run(randomUUID(), key, title, kind, bubble.side, bubble.text, now + index, source)
    })
  }

  recentOut(key: string, limit: number): string[] {
    const rows = this.db
      .prepare(
        'SELECT text FROM turns WHERE conv_key = ? AND side = ? AND at > ? ORDER BY at DESC, rowid DESC LIMIT ?'
      )
      .all(key, 'out', this.resumedAt(key), limit) as Array<{ text: string }>
    return rows.map((row) => row.text).reverse()
  }

  /** 恢复自动之后，恢复前发出的重复回复不再当作「回复重复」。 */
  private resumedAt(key: string): number {
    const row = this.db.prepare('SELECT resumed_at FROM conv_state WHERE conv_key = ?').get(key) as
      | { resumed_at: number }
      | undefined
    return row?.resumed_at ?? 0
  }

  isCold(key: string): boolean {
    const row = this.db.prepare('SELECT conv_key FROM cold_list WHERE conv_key = ?').get(key) as
      | { conv_key: string }
      | undefined
    return Boolean(row)
  }

  listCold(): ColdEntry[] {
    const rows = this.db
      .prepare('SELECT conv_key, title, kind, note, created_at FROM cold_list ORDER BY created_at DESC')
      .all() as Array<{ conv_key: string; title: string; kind: ConversationKind; note: string; created_at: number }>
    return rows.map((row) => ({
      key: row.conv_key,
      title: row.title,
      kind: row.kind,
      note: row.note,
      createdAt: row.created_at
    }))
  }

  addCold(entry: ColdEntry): void {
    this.db
      .prepare(
        'INSERT INTO cold_list (conv_key, title, kind, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(conv_key) DO UPDATE SET title = excluded.title, note = excluded.note'
      )
      .run(entry.key, entry.title, entry.kind, entry.note, entry.createdAt)
  }

  removeCold(key: string): void {
    this.db.prepare('DELETE FROM cold_list WHERE conv_key = ?').run(key)
  }

  isHandedOff(key: string): boolean {
    const row = this.db.prepare('SELECT handed_off FROM conv_state WHERE conv_key = ?').get(key) as
      | { handed_off: number }
      | undefined
    return row?.handed_off === 1
  }

  setHandedOff(key: string, title: string, kind: ConversationKind, handedOff: boolean): void {
    this.ensureConv(key, title, kind)
    this.db.prepare('UPDATE conv_state SET handed_off = ?, title = ? WHERE conv_key = ?').run(handedOff ? 1 : 0, title, key)
  }

  resume(key: string): void {
    const latest = this.db.prepare('SELECT MAX(at) AS at FROM turns WHERE conv_key = ?').get(key) as
      | { at: number | null }
      | undefined
    // 同一毫秒里连续写入的气泡会占用 now+1。标记必须落在它们之后，否则恢复后仍会看成回复重复。
    const mark = Math.max(Date.now(), Number(latest?.at ?? 0)) + 1
    this.db
      .prepare('UPDATE conv_state SET handed_off = 0, bad_count = 0, resumed_at = ? WHERE conv_key = ?')
      .run(mark, key)
  }

  handledInbound(key: string): string[] {
    const row = this.db.prepare('SELECT handled_inbound FROM conv_state WHERE conv_key = ?').get(key) as
      | { handled_inbound: string }
      | undefined
    if (!row?.handled_inbound) return []
    try {
      const parsed = JSON.parse(row.handled_inbound) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
    } catch {
      return []
    }
  }

  setHandledInbound(key: string, title: string, kind: ConversationKind, texts: string[]): void {
    this.ensureConv(key, title, kind)
    this.db.prepare('UPDATE conv_state SET handled_inbound = ? WHERE conv_key = ?').run(JSON.stringify(texts), key)
  }

  listHandedOff(): Array<{ key: string; title: string }> {
    return this.db
      .prepare('SELECT conv_key AS key, title FROM conv_state WHERE handed_off = 1')
      .all() as unknown as Array<{ key: string; title: string }>
  }

  badCount(key: string): number {
    const row = this.db.prepare('SELECT bad_count FROM conv_state WHERE conv_key = ?').get(key) as
      | { bad_count: number }
      | undefined
    return row?.bad_count ?? 0
  }

  bumpBad(key: string, title: string, kind: ConversationKind): number {
    this.ensureConv(key, title, kind)
    this.db.prepare('UPDATE conv_state SET bad_count = bad_count + 1 WHERE conv_key = ?').run(key)
    return this.badCount(key)
  }

  resetBad(key: string): void {
    this.db.prepare('UPDATE conv_state SET bad_count = 0 WHERE conv_key = ?').run(key)
  }

  addEvent(event: ShiftEvent): void {
    this.db
      .prepare('INSERT INTO events (id, conv_key, title, at, kind, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), event.key, event.title, event.at, event.kind, event.reason)
  }

  eventsBetween(start: number, end: number): ShiftEvent[] {
    return this.db
      .prepare(
        'SELECT conv_key AS key, title, at, kind, reason FROM events WHERE at >= ? AND at < ? ORDER BY at ASC'
      )
      .all(start, end) as unknown as ShiftEvent[]
  }

  sentCountSince(start: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND at >= ?')
      .get('replied', start) as { n: number }
    return row.n
  }

  knowledgeFileNames(packId: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT file_name FROM knowledge WHERE pack_id = ? ORDER BY file_name ASC')
      .all(packId) as Array<{ file_name: string }>
    return rows.map((row) => row.file_name)
  }

  knowledgeChunks(packId: string): KnowledgeChunk[] {
    const rows = this.db
      .prepare('SELECT id, file_name, title, text FROM knowledge WHERE pack_id = ?')
      .all(packId) as Array<{ id: string; file_name: string; title: string; text: string }>
    return rows.map((row) => ({
      id: row.id,
      fileName: row.file_name,
      title: row.title,
      text: row.text
    }))
  }

  addKnowledgeFile(packId: string, fileName: string, chunks: KnowledgeChunk[]): void {
    this.db.prepare('DELETE FROM knowledge WHERE pack_id = ? AND file_name = ?').run(packId, fileName)
    const insert = this.db.prepare(
      'INSERT INTO knowledge (id, pack_id, file_name, title, text) VALUES (?, ?, ?, ?, ?)'
    )
    for (const chunk of chunks) {
      insert.run(randomUUID(), packId, fileName, chunk.title, chunk.text)
    }
  }

  removeKnowledgeFile(packId: string, fileName: string): void {
    this.db.prepare('DELETE FROM knowledge WHERE pack_id = ? AND file_name = ?').run(packId, fileName)
  }

  private ensureConv(key: string, title: string, kind: ConversationKind): void {
    this.db
      .prepare(
        'INSERT INTO conv_state (conv_key, title, kind, handed_off, bad_count) VALUES (?, ?, ?, 0, 0) ON CONFLICT(conv_key) DO UPDATE SET title = excluded.title'
      )
      .run(key, title, kind)
  }

  private insertAgent(agent: AgentProfile, position: number, enabled: boolean): void {
    this.db
      .prepare('INSERT INTO agents (id, position, json, enabled) VALUES (?, ?, ?, ?)')
      .run(agent.id, position, JSON.stringify(agent), enabled ? 1 : 0)
  }

  private nextPosition(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS n FROM agents').get() as { n: number }
    return row.n + 1
  }

  private copyKnowledge(fromId: string, toId: string): void {
    const rows = this.db
      .prepare('SELECT file_name, title, text FROM knowledge WHERE pack_id = ?')
      .all(fromId) as Array<{ file_name: string; title: string; text: string }>
    const insert = this.db.prepare(
      'INSERT INTO knowledge (id, pack_id, file_name, title, text) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(randomUUID(), toId, row.file_name, row.title, row.text)
    }
  }
}
