/**
 * dsh-web-search-bailian — Alibaba Cloud Bailian (DashScope) WebSearch provider for DSH.
 *
 * Registers a WebSearchProvider into `ctx.web` so that the model-facing `web_search`
 * tool natively queries Bailian WebSearch via its MCP/API endpoint without requiring
 * DeepSeek official credentials or third-party paid search proxies.
 *
 * Key resolution:
 *   1. Plugin config `apiKey` or `apiKeyEnv`
 *   2. Environment variables: `QWEN_API_KEY`, `DASHSCOPE_API_KEY`, `BAILIAN_API_KEY`
 *   3. DSH credentials service (`ctx.credentials.resolve('QWEN_API_KEY')`)
 *   4. Bailian CLI local config (`~/.bailian/config.json`)
 *   5. Local DSH credentials (`~/.dsh/.credentials.yaml`)
 *
 * @module dsh-web-search-bailian
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'web-search-bailian'
export const inject = ['web']

const DEFAULT_MCP_URL = 'https://dashscope.aliyuncs.com/api/v1/mcps/WebSearch/mcp'

function resolveBailianKey(ctx, config) {
  if (config.apiKey) return config.apiKey
  const envName = config.apiKeyEnv || 'QWEN_API_KEY'
  if (process.env[envName]) return process.env[envName]
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY
  if (process.env.BAILIAN_API_KEY) return process.env.BAILIAN_API_KEY

  // Try DSH credentials service if available
  try {
    const cred = ctx.credentials?.resolve?.(envName) || ctx.credentials?.resolve?.('QWEN_API_KEY')
    if (cred) return cred
  } catch {}

  // Fallback to ~/.bailian/config.json
  try {
    const blConfigPath = path.join(os.homedir(), '.bailian', 'config.json')
    if (fs.existsSync(blConfigPath)) {
      const data = JSON.parse(fs.readFileSync(blConfigPath, 'utf8'))
      if (data.apiKey) return data.apiKey
    }
  } catch {}

  // Fallback to ~/.dsh/.credentials.yaml
  try {
    const dshCredPath = path.join(os.homedir(), '.dsh', '.credentials.yaml')
    if (fs.existsSync(dshCredPath)) {
      const content = fs.readFileSync(dshCredPath, 'utf8')
      const match = content.match(/QWEN_API_KEY:\s*([^\s]+)/)
      if (match) return match[1]
    }
  } catch {}

  return undefined
}

export class BailianSearchProvider {
  id = 'bailian'

  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.config = config
    this.endpoint = config.url || DEFAULT_MCP_URL
  }

  available() {
    return true
  }

  async search(request, signal) {
    const apiKey = resolveBailianKey(this.ctx, this.config)
    if (!apiKey) {
      throw new Error('Bailian WebSearch has no API key; set QWEN_API_KEY, DASHSCOPE_API_KEY, or run `bl auth login`')
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'x-dashscope-source-config': JSON.stringify({
        channel: 'bailian-cli',
        tags: { t1: 'public', t2: 'bl', t3: '2.1.0' }
      }),
      'x-dashscope-openapisource': 'BailianCLI',
      'X-Dashscope-Service': 'bailian-cli',
      'Content-Type': 'application/json'
    }

    const count = request.maxResults || 5
    const body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'bailian_web_search',
        arguments: {
          query: request.query,
          count
        }
      }
    }

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Bailian WebSearch HTTP ${res.status}: ${errText}`)
    }

    const data = await res.json()
    if (data.error) {
      throw new Error(`Bailian WebSearch RPC error: ${JSON.stringify(data.error)}`)
    }

    const contentItem = data.result?.content?.[0]
    let parsed
    try {
      parsed = JSON.parse(contentItem?.text || '{}')
    } catch {
      parsed = {}
    }

    const pages = parsed.pages || []
    const sources = pages.map(p => ({
      title: p.title || p.hostname || 'Web page',
      url: p.url,
      snippet: p.snippet
    }))

    return {
      sources,
      truncated: false
    }
  }
}

export function apply(ctx, config = {}) {
  const provider = new BailianSearchProvider(ctx, config)
  ctx.web.registerSearchProvider(provider)
}
