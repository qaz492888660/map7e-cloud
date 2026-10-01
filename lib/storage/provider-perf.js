import { AsyncLocalStorage } from 'node:async_hooks'

const context = new AsyncLocalStorage()
const moduleLoadedAt = Date.now()
let requestSequence = 0

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000
}

function rounded(value) {
  return Math.round(value * 10) / 10
}

export function currentProviderPerf() {
  return context.getStore() || null
}

export function recordProviderPerf(name, durationMs, attributes = {}) {
  const metrics = currentProviderPerf()
  if (!metrics) return
  const event = { name, ms: rounded(Math.max(0, durationMs)) }
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)) event[key] = value
  }
  metrics.events.push(event)
}

export async function withProviderPerf(task) {
  const metrics = {
    events: [],
    instanceRequest: ++requestSequence,
    moduleAgeMs: Math.max(0, Date.now() - moduleLoadedAt),
    processUptimeMs: Math.round(process.uptime() * 1000),
    upstreamRequests: 0,
  }
  const startedAt = nowMs()
  return context.run(metrics, async () => {
    try {
      const result = await task(metrics)
      metrics.outcome ??= 'ok'
      return result
    } catch (error) {
      metrics.outcome = 'error'
      throw error
    } finally {
      metrics.handlerMs = rounded(nowMs() - startedAt)
      if (process.env.VERCEL_ENV === 'preview') {
        console.info('[provider-perf]', JSON.stringify(metrics))
      }
    }
  })
}

export function providerPerfNow() {
  return nowMs()
}
