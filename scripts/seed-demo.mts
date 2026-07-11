// Seeds a realistic demo show into a local server's DB for screenshots/dev.
// Usage: DATA_DIR=/tmp/sr-demo npx tsx scripts/seed-demo.mts
import { Store } from '../src/server/store.js'
import { mkdirSync } from 'node:fs'

const dataDir = process.env.DATA_DIR ?? '/tmp/sr-demo'
mkdirSync(dataDir, { recursive: true })
const store = new Store(`${dataDir}/showrunner.db`)
const SHOW = 'mygame'

const director = store.register(SHOW, 'claude-local', 'planning session', undefined, 'https://claude.ai/code/session_demo123')
const w1 = store.register(SHOW, 'claude-cloud', 'cloud worker')
const w2 = store.register(SHOW, 'cursor-local', 'cursor session')
const w3 = store.register(SHOW, 'claude-local', 'laptop worker', undefined, undefined, 'claude --resume 7f3a9c')
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
// failed (agent-reported; claimed and failed by w1 before it picks up its working task)
const fail1 = t('Upgrade physics dep to 2.x', 'Bump cube-phys; see apps/server/package.json.', { filesHint: ['apps/server/**'] })
store.claimNextTask(w1.id)
store.updateTask(w1.id, fail1.id, {
  status: 'failed',
  note: 'npm install fails: cube-phys 2.x peer-conflicts with cubekit 3.1; needs a call on pinning or forking.',
})
// working
const wk1 = t('Chunk-save batching for world server', 'Persist dirty chunks in batches of 64; see server/src/persist.rs.', { filesHint: ['apps/server/src/persist/**'], priority: 4 })
store.claimNextTask(w1.id)
store.updateTask(w1.id, wk1.id, { status: 'working', note: 'batch writer in place, tuning flush interval' })
store.saveNote(w1.id, {
  body: 'Gotcha: the dirty-set must flush before the double-buffer swap, not after -- swap-then-flush drops up to 64 chunks if the process dies mid-tick. Cost us a corrupted save in staging.',
  tags: ['gotcha', 'persist'],
  filesHint: ['apps/server/src/persist/**'],
  taskId: wk1.id,
})
const wk2 = t('Day/night lighting pass', 'Interpolate ambient light by world clock; docs/lighting.md has curves.', { filesHint: ['apps/web/src/render/**'] })
store.claimNextTask(w2.id)
store.updateTask(w2.id, wk2.id, { status: 'working', note: 'dawn/dusk gradient landed, testing torch falloff' })
// input-required (pulses amber in the needs-input column)
const blocked = t('Invite links expire after 24h', 'Gateway change; see apps/gateway/src/invites.ts.', { filesHint: ['apps/gateway/**'], priority: 2 })
store.claimNextTask(w3.id)
store.updateTask(w3.id, blocked.id, { status: 'input-required', note: 'Should expired links show a renew flow or a plain 410?' })
store.sendMessage(w3.id, 'director', 'Invite expiry UX: renew flow or plain 410? Brief does not say.', blocked.id)
store.saveNote(director.id, {
  body: 'Decision: expired invite links show "this link expired, ask for a new one" instead of a bare 410. Keeps the funnel from dead-ending. Applies to any future expiring-link flow, not just invites.',
  tags: ['decision'],
  taskId: blocked.id,
})
// queued
t('Mob pathfinding on slopes', 'A* cost tweak; vendor/cubekit notes in docs/pathing.md.', { priority: 2 })
t('Dungeon floor 3 loot table', 'Balance pass per docs/economy.md section 4.', { dependsOn: [wk1.id] })
store.sendMessage(director.id, 'all', 'Digest: crafting UI merged, chunk batching and lighting in flight, invites blocked on a UX question. Queue has 2 more; shout if idle.')

console.log('seeded show', SHOW, 'at', dataDir)
