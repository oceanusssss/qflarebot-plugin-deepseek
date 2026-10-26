import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockContext, createMockSession, runCommand } from '@qqbot/sdk/testing'
import { normalizePlugin, type ScopedDB, type Session } from '@qqbot/sdk'
import plugin, { chat, defaults } from './index.js'

let sqlite: DatabaseSync
let db: ScopedDB
const config = { ...defaults, apiKey: 'test-key-do-not-log' }
const reply = (content = '你好！') => Response.json({ choices: [{ message: { content } }] })
const sql = (value: string) => value.replace(/\{([a-z_]+)\}/g, 'p_deepseek_$1')
const context = (overrides = {}) => createMockContext(plugin, { config: { ...config, ...overrides }, db })

async function message(text = '你好', userId = 'alice', targetId = 'group-a', ctx = context()) {
  const session = createMockSession({ content: text, userId, targetId })
  await chat(session, ctx, text)
  return session
}

beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:')
  db = {
    table: name => `p_deepseek_${name}`,
    async exec(query) { sqlite.exec(sql(query)) },
    async run(query, ...params) {
      const result = sqlite.prepare(sql(query)).run(...params as never[])
      return { changes: Number(result.changes) }
    },
    async first<T>(query: string, ...params: unknown[]) { return (sqlite.prepare(sql(query)).get(...params as never[]) ?? null) as T | null },
    async all<T>(query: string, ...params: unknown[]) { return sqlite.prepare(sql(query)).all(...params as never[]) as T[] },
  }
  await plugin.hooks!.onBoot!(context())
  vi.stubGlobal('fetch', vi.fn(async () => reply()))
})

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); sqlite.close() })

describe('QQ group conversational agent', () => {
  it('sends only system instructions and chat text to the pinned official API', async () => {
    expect((await message()).replies).toEqual(['你好！'])
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 600, stream: false })
    expect(body.messages).toEqual([{ role: 'system', content: config.systemPrompt }, { role: 'user', content: '你好' }])
    expect(init!.redirect).toBe('manual')
    expect(init!.body).not.toContain('alice')
    expect(init!.body).not.toContain('group-a')
  })

  it('persists context across new plugin contexts and separates users and groups', async () => {
    await message('第一问')
    await message('接着说')
    let body = JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string)
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([config.systemPrompt, '第一问', '你好！', '接着说'])
    await message('新用户', 'bob')
    await message('新群', 'alice', 'group-b')
    for (const index of [2, 3]) {
      body = JSON.parse(vi.mocked(fetch).mock.calls[index]![1]!.body as string)
      expect(body.messages).toHaveLength(2)
    }
  })

  it('ignores unmentioned messages and non-group scenes', async () => {
    for (const options of [{ atMe: false }, { scene: 'c2c' as const }]) {
      const session = createMockSession(options)
      await chat(session, context(), '你好')
      expect(session.replies).toEqual([])
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('handles plain @ messages and skips slash commands in the fallback matcher', async () => {
    const rule = normalizePlugin(plugin).regex[0]!
    const normal = createMockSession({ content: '你好' })
    await rule.handler({ session: normal, ctx: context(), match: ['你好'] })
    const slash = createMockSession({ content: '/sid' })
    await rule.handler({ session: slash, ctx: context(), match: ['/sid'] })
    expect(normal.replies).toEqual(['你好！'])
    expect(slash.replies).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('clears only the requesting user in the current group without an API call', async () => {
    await message('记住苹果')
    const result = await runCommand(plugin, 'clear', '', { session: { userId: 'alice', targetId: 'group-a' }, ctx: { config, db } })
    expect(result.replies[0]).toContain('已清空')
    await message('还有什么')
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string).messages).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('enforces a persistent daily call cap before making a paid request', async () => {
    const ctx = context({ dailyRequests: 1 })
    await message('第一问', 'alice', 'group-a', ctx)
    const limited = await message('第二问', 'bob', 'group-a', ctx)
    expect(limited.replies[0]).toContain('次数已用完')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('atomically blocks concurrent messages for the same conversation', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const first = message('较慢的问题')
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const second = await message('重复问题')
    expect(second.replies[0]).toContain('上一个问题')
    finish(reply())
    await first
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('caps retained history and expires old context', async () => {
    const ctx = context({ historyTurns: 1 })
    await message('一', 'alice', 'group-a', ctx)
    await message('二', 'alice', 'group-a', ctx)
    await message('三', 'alice', 'group-a', ctx)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[2]![1]!.body as string).messages.map((m: { content: string }) => m.content))
      .toEqual([config.systemPrompt, '二', '你好！', '三'])
    sqlite.exec('UPDATE p_deepseek_conversations SET updated_at = 0')
    await message('过期后', 'alice', 'group-a', ctx)
    expect(JSON.parse(vi.mocked(fetch).mock.calls[3]![1]!.body as string).messages).toHaveLength(2)
  })

  it('does not leak provider error bodies and does not save failed responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('test-key-do-not-log secret body', { status: 401 })))
    const result = await message()
    expect(result.replies[0]).toContain('密钥未通过验证')
    expect(JSON.stringify(result.replies)).not.toContain('test-key-do-not-log')
    expect(sqlite.prepare('SELECT history, locked_until FROM p_deepseek_conversations').get()).toMatchObject({ history: '[]', locked_until: 0 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses provider redirects without forwarding credentials or saving a reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      if (init.redirect === 'error') throw new TypeError('Workers does not support this redirect mode')
      expect(init.redirect).toBe('manual')
      return new Response(null, { status: 307, headers: { Location: 'https://other-origin.invalid/' } })
    }))
    const result = await message()
    expect(result.replies[0]).toContain('暂时不可用')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(result.replies)).not.toContain('test-key-do-not-log')
    expect(sqlite.prepare('SELECT history FROM p_deepseek_conversations').get()).toMatchObject({ history: '[]' })
  })

  it('aborts at 20 seconds and releases the conversation lock', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('private detail')))
    })))
    const running = message('慢问题')
    await vi.advanceTimersByTimeAsync(20_001)
    expect((await running).replies[0]).toContain('超时')
    expect(sqlite.prepare('SELECT locked_until FROM p_deepseek_conversations').get()).toMatchObject({ locked_until: 0 })
  })

  it('rejects missing credentials and oversized inputs before any paid request', async () => {
    expect((await message('你好', 'alice', 'group-a', context({ apiKey: '' }))).replies[0]).toContain('还未配置')
    expect((await message('啊'.repeat(3001))).replies[0]).toContain('太长')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('splits long replies below the QQ passive reply cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('好'.repeat(4000))))
    const result = await message()
    expect(result.replies).toHaveLength(3)
    expect(result.replies.join('')).toContain('已截断')
    for (const part of result.replies) expect((part as string).length).toBeLessThanOrEqual(1500)
  })

  it('does not save answers QQ failed to deliver', async () => {
    const session = createMockSession({ maxPassiveReplies: 0 })
    await chat(session, context(), '你好')
    expect(session.replies).toEqual([])
    expect(sqlite.prepare('SELECT history FROM p_deepseek_conversations').get()).toMatchObject({ history: '[]' })
  })

  it('deletes expired stored context during the daily cleanup', async () => {
    await message()
    sqlite.exec('UPDATE p_deepseek_conversations SET updated_at = 0')
    const cleanup = normalizePlugin(plugin).cron[0]!
    await cleanup.handler({ ctx: context(), job: cleanup.name, scheduledAt: Date.now() })
    expect(sqlite.prepare('SELECT COUNT(*) AS total FROM p_deepseek_conversations').get()).toMatchObject({ total: 0 })
  })
})
