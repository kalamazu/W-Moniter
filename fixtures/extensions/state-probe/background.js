importScripts('config.js')
let running = null

const sessionId = async () => {
  const current = await chrome.storage.session.get('monitorSessionId')
  if (current.monitorSessionId) return current.monitorSessionId
  const value = crypto.randomUUID()
  await chrome.storage.session.set({ monitorSessionId: value })
  return value
}

const controlledToggle = async (all, errors) => {
  if (!globalThis.MONITOR_CONTROLLED_TOGGLE) return { authorized: false, phase: 'not_requested' }
  const targetName = String(globalThis.MONITOR_MANAGED_TARGET_NAME ?? '')
  const saved = await chrome.storage.local.get(['togglePhase', 'toggleDisabledSession', 'toggleTargetId', 'toggleAudit'])
  let target = all.find(item => item.type === 'extension' && item.name === targetName)
  if (!target && saved.toggleTargetId) {
    try { target = await chrome.management.get(saved.toggleTargetId) } catch { /* absent is reported below */ }
  }
  if (!target || target.id === chrome.runtime.id) {
    errors.push('controlled_toggle:target_not_found')
    return { authorized: true, phase: 'target_not_found', targetName, targetId: saved.toggleTargetId ?? null }
  }

  const session = await sessionId()
  const audit = Array.isArray(saved.toggleAudit) ? saved.toggleAudit.slice(-20) : []
  const reason = String(globalThis.MONITOR_CONTROL_REASON ?? 'controlled_acceptance_probe').slice(0, 160)
  const before = await chrome.management.get(target.id)

  if (saved.togglePhase !== 'await_restart' && saved.togglePhase !== 'complete') {
    if (!before.enabled) await chrome.management.setEnabled(target.id, true)
    await chrome.management.setEnabled(target.id, false)
    const after = await chrome.management.get(target.id)
    audit.push({ ts: Date.now(), operation: 'setEnabled(false)', targetId: target.id,
      before: before.enabled, after: after.enabled, authorized: true, reason })
    await chrome.storage.local.set({ togglePhase: 'await_restart', toggleDisabledSession: session,
      toggleTargetId: target.id, toggleAudit: audit })
    return { authorized: true, phase: 'disabled_wait_restart', targetId: target.id, targetName,
      beforeEnabled: before.enabled, afterEnabled: after.enabled, restartObservedDisabled: null, audit }
  }

  if (saved.togglePhase === 'await_restart') {
    // chrome.storage.session survives service-worker suspension but is cleared by a real
    // browser restart. This prevents a worker reload from masquerading as restart proof.
    if (saved.toggleDisabledSession === session) {
      return { authorized: true, phase: 'disabled_wait_restart', targetId: target.id, targetName,
        beforeEnabled: before.enabled, afterEnabled: before.enabled, restartObservedDisabled: null, audit }
    }
    const restartObservedDisabled = before.enabled === false
    let postRestartDisabledObserved = restartObservedDisabled
    let enableBefore = before.enabled
    const forcedReenabledOnLoad = before.enabled === true
    if (forcedReenabledOnLoad) {
      // Loading an unpacked fixture for a new debugging session forces it enabled.
      // Re-run the disable half explicitly and audit that boundary instead of
      // pretending the debug loader proves production installation persistence.
      await chrome.management.setEnabled(target.id, false)
      const disabled = await chrome.management.get(target.id)
      postRestartDisabledObserved = disabled.enabled === false
      enableBefore = disabled.enabled
      audit.push({ ts: Date.now(), operation: 'setEnabled(false):post_restart', targetId: target.id,
        before: before.enabled, after: disabled.enabled, authorized: true, reason,
        forcedReenabledOnLoad })
    }
    await chrome.management.setEnabled(target.id, true)
    const after = await chrome.management.get(target.id)
    audit.push({ ts: Date.now(), operation: 'setEnabled(true)', targetId: target.id,
      before: enableBefore, after: after.enabled, authorized: true, reason, restartObservedDisabled })
    await chrome.storage.local.set({ togglePhase: 'complete', toggleAudit: audit })
    return { authorized: true, phase: 'complete', targetId: target.id, targetName,
      beforeEnabled: before.enabled, afterEnabled: after.enabled, restartObservedDisabled,
      forcedReenabledOnLoad, postRestartDisabledObserved, audit }
  }

  return { authorized: true, phase: 'complete', targetId: target.id, targetName,
    beforeEnabled: before.enabled, afterEnabled: before.enabled, restartObservedDisabled: true, audit }
}

const run = async () => {
  if (running) return running
  running = (async () => {
  const manifest = chrome.runtime.getManifest()
  const errors = []
  let selfInfo = null, all = [], starts = 0
  try { selfInfo = await chrome.management.getSelf(); all = await chrome.management.getAll() }
  catch (error) { errors.push('management:' + String(error)) }
  try {
    const saved = await chrome.storage.local.get('starts')
    starts = Number(saved.starts ?? 0) + 1
    await chrome.storage.local.set({ starts })
  } catch (error) { errors.push('storage:' + String(error)) }
  let control = { authorized: false, phase: 'not_requested' }
  try { control = await controlledToggle(all, errors); all = await chrome.management.getAll() }
  catch (error) { errors.push('controlled_toggle:' + String(error)); control = { authorized: true, phase: 'failed' } }
  if (globalThis.MONITOR_REPORT_URL) {
    await fetch(globalThis.MONITOR_REPORT_URL, { method: 'POST', mode: 'no-cors',
      body: JSON.stringify({ extensionId: chrome.runtime.id, starts, version: manifest.version,
        permissions: manifest.permissions, errors, self: selfInfo ? { enabled: selfInfo.enabled, type: selfInfo.type } : null,
        control,
        all: all.filter(item => item.type === 'extension').slice(0, 50).map(item => ({ id: item.id, name: item.name, version: item.version, enabled: item.enabled,
          permissions: item.permissions ?? [] })) }) }).catch(() => {})
  }
  })()
  try { await running } finally { running = null }
}
chrome.runtime.onInstalled.addListener(() => { void run() })
chrome.runtime.onStartup.addListener(() => { void run() })
void run()
