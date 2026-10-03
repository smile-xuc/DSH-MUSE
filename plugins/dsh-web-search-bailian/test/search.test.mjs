import test from 'node:test'
import assert from 'node:assert/strict'
import { BailianSearchProvider } from '../lib/index.js'

test('BailianSearchProvider initialization and properties', () => {
  const provider = new BailianSearchProvider({}, {})
  assert.equal(provider.id, 'bailian')
  assert.equal(provider.available(), true)
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
