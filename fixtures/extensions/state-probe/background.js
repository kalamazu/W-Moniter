importScripts('config.js')
const run = async () => {
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
  if (globalThis.MONITOR_REPORT_URL) {
    await fetch(globalThis.MONITOR_REPORT_URL, { method: 'POST', mode: 'no-cors',
      body: JSON.stringify({ extensionId: chrome.runtime.id, starts, version: manifest.version,
        permissions: manifest.permissions, errors, self: selfInfo ? { enabled: selfInfo.enabled, type: selfInfo.type } : null,
        all: all.filter(item => item.type === 'extension').slice(0, 50).map(item => ({ id: item.id, name: item.name, version: item.version, enabled: item.enabled,
          permissions: item.permissions ?? [] })) }) }).catch(() => {})
  }
}
chrome.runtime.onInstalled.addListener(() => { void run() })
chrome.runtime.onStartup.addListener(() => { void run() })
void run()
