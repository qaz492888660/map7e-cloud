// Cloud and Worker share one budget for a HEAD bytes=0-0 capability probe.
// This budget never applies to an original GET or a playback response body.
export const MEDIA_PROBE_TIMEOUT_MS = 20_000
export const MEDIA_PROBE_RESPONSE_MARGIN_MS = 1_000
export const MEDIA_PROBE_DEADLINE_HEADER = 'X-Media-Probe-Deadline'
export const MEDIA_PROBE_DEADLINE_ERROR = 'media_probe_deadline_exceeded'

export function createMediaProbeScope({ timeoutMs, signal, errorFor }) {
  const controller = new AbortController()
  const abort = code => {
    if (!controller.signal.aborted) controller.abort(errorFor(code))
  }
  const onParentAbort = () => abort('media_probe_cancelled')
  if (signal?.aborted) onParentAbort()
  else signal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => abort(MEDIA_PROBE_DEADLINE_ERROR), Math.max(0, timeoutMs))
  if (timeoutMs <= 0) abort(MEDIA_PROBE_DEADLINE_ERROR)
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason
  }
  const wait = operation => new Promise((resolve, reject) => {
    const onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
    Promise.resolve(operation).then(value => {
      if (controller.signal.aborted) {
        // Also release a response returned by a transport that ignored abort.
        Promise.resolve(value?.body?.cancel()).catch(() => {})
        reject(controller.signal.reason)
      } else resolve(value)
    }, reject).finally(() => controller.signal.removeEventListener('abort', onAbort))
  })
  return {
    signal: controller.signal,
    check,
    wait,
    fetch: fetchImpl => async (input, init = {}) => {
      check()
      const response = await wait(fetchImpl(input, { ...init,
        signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }))
      check()
      return response
    },
    dispose() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onParentAbort)
    },
  }
}
