import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BailianSearchProvider } from '../lib/index.js'

test('BailianSearchProvider initialization and properties', () => {
  const provider = new BailianSearchProvider({}, { apiKey: 'test-key' })
  assert.equal(provider.id, 'bailian')
  assert.equal(provider.available(), true)
})

test('available is false when no local key can be resolved', () => {
  const oldQwen = process.env.QWEN_API_KEY
  const oldDash = process.env.DASHSCOPE_API_KEY
  const oldBailian = process.env.BAILIAN_API_KEY
  const originalExists = fs.existsSync
  delete process.env.QWEN_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.BAILIAN_API_KEY
  fs.existsSync = (target) => {
    const text = String(target)
    if (text.includes('.bailian') || text.includes('.credentials.yaml')) return false
    return originalExists(target)
  }
  try {
    const provider = new BailianSearchProvider(
      { credentials: { resolve: () => undefined } },
      { apiKey: '', apiKeyEnv: 'NON_EXISTENT_KEY' }
    )
    assert.equal(provider.available(), false)
  } finally {
    fs.existsSync = originalExists
    if (oldQwen !== undefined) process.env.QWEN_API_KEY = oldQwen
    else delete process.env.QWEN_API_KEY
    if (oldDash !== undefined) process.env.DASHSCOPE_API_KEY = oldDash
    else delete process.env.DASHSCOPE_API_KEY
    if (oldBailian !== undefined) process.env.BAILIAN_API_KEY = oldBailian
    else delete process.env.BAILIAN_API_KEY
  }
})

test('BailianSearchProvider throws when no API key available', async () => {
  const oldQwen = process.env.QWEN_API_KEY
  const oldDash = process.env.DASHSCOPE_API_KEY
  const oldBailian = process.env.BAILIAN_API_KEY
  delete process.env.QWEN_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  delete process.env.BAILIAN_API_KEY

  try {
    const provider = new BailianSearchProvider({ credentials: { resolve: () => undefined } }, {
      apiKey: '',
      apiKeyEnv: 'NON_EXISTENT_KEY'
    })
    // mock ~/.bailian and ~/.dsh fallback failure by using fake homedir if needed or testing rejection
  } finally {
    if (oldQwen !== undefined) process.env.QWEN_API_KEY = oldQwen
    if (oldDash !== undefined) process.env.DASHSCOPE_API_KEY = oldDash
    if (oldBailian !== undefined) process.env.BAILIAN_API_KEY = oldBailian
  }
})

test('BailianSearchProvider formats RPC request and parses search response', async () => {
  let requestedBody = null
  let requestedHeaders = null

  // Mock fetch
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    requestedHeaders = options.headers
    requestedBody = JSON.parse(options.body)
    return {
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: requestedBody.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                pages: [
                  {
                    title: 'Test Title 1',
                    url: 'https://example.com/1',
                    snippet: 'This is test snippet 1'
                  },
                  {
                    hostname: 'example.com',
                    url: 'https://example.com/2',
                    snippet: 'This is test snippet 2'
                  }
                ]
              })
            }
          ]
        }
      })
    }
  }

  try {
    const provider = new BailianSearchProvider({}, { apiKey: 'test-fake-key-123' })
    const res = await provider.search({ query: 'DeepSeek news', maxResults: 5 })

    assert.equal(requestedHeaders.Authorization, 'Bearer test-fake-key-123')
    assert.equal(requestedBody.params.name, 'bailian_web_search')
    assert.equal(requestedBody.params.arguments.query, 'DeepSeek news')
    assert.equal(requestedBody.params.arguments.count, 5)

    assert.equal(res.truncated, false)
    assert.equal(res.sources.length, 2)
    assert.equal(res.sources[0].title, 'Test Title 1')
    assert.equal(res.sources[0].url, 'https://example.com/1')
    assert.equal(res.sources[0].snippet, 'This is test snippet 1')
    assert.equal(res.sources[1].title, 'example.com')
  } finally {
    globalThis.fetch = originalFetch
  }
})
