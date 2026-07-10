// Seeds a realistic demo show into a local server's DB for screenshots/dev.
// Usage: DATA_DIR=/tmp/sr-demo npx tsx scripts/seed-demo.mts
import { Store } from '../src/server/store.js'
import { mkdirSync } from 'node:fs'

const dataDir = process.env.DATA_DIR ?? '/tmp/sr-demo'
mkdirSync(dataDir, { recursive: true })
const store = new Store(`${dataDir}/showrunner.db`)
const SHOW = 'mygame'

const director = store.register(SHOW, 'claude-local', 'planning session')
const w1 = store.register(SHOW, 'claude-cloud', 'cloud worker')
const w2 = store.register(SHOW, 'cursor-local', 'cursor session')
const w3 = store.register(SHOW, 'claude-local', 'laptop worker')
store.claimDirection(director.id, true)

const t = (title: string, brief: string, extra: Record<string, unknown> = {}) =>
  store.createTask({ show: SHOW, title, brief, createdBy: director.id, ...extra }).task

// completed
const done1 = t('Wire crafting bench UI to inventory', 'See docs/crafting.md; branch off main.', { filesHint: ['apps/web/src/crafting/**'], priority: 3 })
store.claimNextTask(w3.id)
store.updateTask(w3.id, done1.id, { status: 'working', note: 'UI grid renders; wiring drag handlers' })
store.updateTask(w3.id, done1.id, {
  status: 'completed', note: 'done, 14 files',
  artifacts: [{ kind: 'branch', name: 'show/' + done1.id + '-crafting-ui' }, { kind: 'text', text: 'Crafting bench pulls live inventory; drag-to-slot works; 6 new tests.' }],
})
// working
const wk1 = t('Chunk-save batching for world server', 'Persist dirty chunks in batches of 64; see server/src/persist.rs.', { filesHint: ['apps/server/src/persist/**'], priority: 4 })
store.claimNextTask(w1.id)
store.updateTask(w1.id, wk1.id, { status: 'working', note: 'batch writer in place, tuning flush interval' })
const wk2 = t('Day/night lighting pass', 'Interpolate ambient light by world clock; docs/lighting.md has curves.', { filesHint: ['apps/web/src/render/**'] })
store.claimNextTask(w2.id)
store.updateTask(w2.id, wk2.id, { status: 'working', note: 'dawn/dusk gradient landed, testing torch falloff' })
// input-required (escalation banner)
const blocked = t('Invite links expire after 24h', 'Gateway change; see apps/gateway/src/invites.ts.', { filesHint: ['apps/gateway/**'], priority: 2 })
store.claimNextTask(w3.id)
store.updateTask(w3.id, blocked.id, { status: 'input-required', note: 'Should expired links show a renew flow or a plain 410?' })
store.sendMessage(w3.id, 'director', 'Invite expiry UX: renew flow or plain 410? Brief does not say.', blocked.id)
store.sendMessage(w3.id, 'human', 'Design call needed on invite expiry UX before I can finish t-invites.', blocked.id)
// queued
t('Mob pathfinding on slopes', 'A* cost tweak; vendor/voxelize notes in docs/pathing.md.', { priority: 2 })
t('Spire floor 3 loot table', 'Balance pass per docs/economy.md section 4.', { dependsOn: [wk1.id] })
store.sendMessage(director.id, 'all', 'Digest: crafting UI merged, chunk batching and lighting in flight, invites blocked on a UX question. Queue has 2 more; shout if idle.')

console.log('seeded show', SHOW, 'at', dataDir)
