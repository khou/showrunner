import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const URL_BASE = process.env.SR_URL ?? (() => { throw new Error('set SR_URL to your deployment, e.g. SR_URL=https://my-app.fly.dev') })()
const TOKEN = process.env.SR_TOKEN ?? readFileSync(`${homedir()}/.showrunner-token`, 'utf8').trim()
const WORKER_TOKEN = process.env.SR_WORKER_TOKEN

async function connect(name: string, token: string = TOKEN) {
  const client = new Client({ name, version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  return client
}

function parse(res: any) {
  return JSON.parse(res.content.find((c: any) => c.type === 'text').text)
}
async function call(c: Client, name: string, args: any) {
  return parse(await c.callTool({ name, arguments: args }, undefined, { timeout: 60000 }))
}
const ok = (label: string, cond: boolean, detail?: any) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : ' :: ' + JSON.stringify(detail)}`)
  if (!cond) process.exitCode = 1
}
// Every tool call after register authenticates with member_id + member_secret.
const auth = (reg: any) => ({ member_id: reg.member_id, member_secret: reg.member_secret })

const SHOW = process.env.SR_SHOW ?? `verify-${Date.now() % 100000}`
const dir1 = await connect('director-1')
const SESSION_URL = 'https://claude.ai/code/session_verify'
const reg1 = await call(dir1, 'register', { show: SHOW, kind: 'other', display_name: 'live-verify director', session_url: SESSION_URL })
ok('register director', !!reg1.member_id && !!reg1.member_secret && typeof reg1.protocol === 'string')

const claim1 = await call(dir1, 'claim_direction', { ...auth(reg1), takeover: true })
ok('claim_direction', typeof claim1.epoch === 'number')

const stateAfterClaim = await fetch(`${URL_BASE}/api/shows/${SHOW}/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })
const stateAfterClaimJson = await stateAfterClaim.json() as any
ok('callboard state exposes director session_url', stateAfterClaimJson.director?.sessionUrl === SESSION_URL, stateAfterClaimJson.director)

const t1 = await call(dir1, 'create_task', {
  ...auth(reg1), epoch: claim1.epoch,
  title: 'Live verify: say hello',
  brief: 'Synthetic task from live-verify script. Complete immediately.',
  priority: 5,
})
ok('create_task', !!t1.task_id, t1)

const worker = await connect('worker-1')
const regW = await call(worker, 'register', { show: SHOW, kind: 'other', display_name: 'live-verify worker' })
const gotTask = await call(worker, 'await_work', { ...auth(regW) })
ok('worker await_work -> task', gotTask.status === 'task' && gotTask.task?.id === t1.task_id, gotTask)

const done = await call(worker, 'update_task', {
  ...auth(regW), task_id: t1.task_id, status: 'completed',
  note: 'hello from live verify',
  artifacts: [{ kind: 'text', text: 'done' }],
})
ok('update_task completed', done.task?.status === 'completed' || done.status === 'completed', done)

const review = await call(dir1, 'await_work', { ...auth(reg1) })
ok('director await_work -> review', review.status === 'review', review)

// long-poll wake: empty queue, create a task 1.5s in, expect resolution well under the hold
const pollP = call(worker, 'await_work', { ...auth(regW) })
const t0 = Date.now()
const lateCreateP = new Promise<any>(resolve => setTimeout(() => {
  resolve(call(dir1, 'create_task', {
    ...auth(reg1), epoch: claim1.epoch,
    title: 'Live verify: long-poll wake', brief: 'Second synthetic task.',
  }))
}, 1500)).catch(e => ({ error: String(e) }))
const woke = await pollP
const dt = Date.now() - t0
const lateCreate = await lateCreateP
ok('mid-poll create_task', !!lateCreate.task_id, lateCreate)
ok(`long-poll wake (<6s, got ${dt}ms)`, woke.status === 'task' && dt < 6000, woke)
await call(worker, 'update_task', { ...auth(regW), task_id: woke.task.id, status: 'completed', note: 'done' })

// notes: create a task with files_hint, worker claims it (relevant_notes present, maybe empty),
// park the worker, director save_note with an overlapping files_hint glob (no task_id --
// exercises the glob-overlap push path, not the same-task shortcut), assert the parked worker's
// poll surfaces it quickly as a kind:'note' message, then search_notes finds it by a word.
const notesGlob = 'apps/live-verify-notes/**'
const t3 = await call(dir1, 'create_task', {
  ...auth(reg1), epoch: claim1.epoch,
  title: 'Live verify: notes flow',
  brief: 'Synthetic task exercising save_note push and search_notes recall.',
  files_hint: [notesGlob],
})
ok('create_task with files_hint', !!t3.task_id, t3)

const gotTask3 = await call(worker, 'await_work', { ...auth(regW) })
ok('worker claims task with files_hint', gotTask3.status === 'task' && gotTask3.task?.id === t3.task_id, gotTask3)
ok('relevant_notes key present on claim', Array.isArray(gotTask3.relevant_notes), gotTask3)

// The worker is now parked holding t3 with nothing else to do (heads-down/idle in the
// protocol's terms): it saves a note before the worker's next poll, so the push lands in the
// inbox and that poll -- which would otherwise just re-confirm the same held task -- surfaces
// the note instead (checkOnce drains messages before it ever re-derives the current task).
const noteWord = `xyzzyverify${Date.now() % 1000000}`
const t1b = Date.now()
const savedNote = await call(dir1, 'save_note', {
  ...auth(reg1),
  body: `Distinctive gotcha for live-verify: ${noteWord} affects this area.`,
  files_hint: [notesGlob],
})
ok('save_note delivered to the parked worker', Array.isArray(savedNote.delivered_to) && savedNote.delivered_to.includes(regW.member_id), savedNote)

const parked = await call(worker, 'await_work', { ...auth(regW) })
const dtb = Date.now() - t1b
ok(`parked poll surfaces the note (<6s, got ${dtb}ms)`, parked.status === 'messages' && parked.messages?.[0]?.kind === 'note' && dtb < 6000, parked)

const search = await call(worker, 'search_notes', { ...auth(regW), query: noteWord })
ok('search_notes finds it by the distinctive word', Array.isArray(search.notes) && search.notes.some((n: any) => n.body.includes(noteWord)), search)

await call(worker, 'update_task', { ...auth(regW), task_id: t3.task_id, status: 'completed', note: 'done' })

// takeover: second director; old epoch must be superseded
const dir2 = await connect('director-2')
const reg2 = await call(dir2, 'register', { show: SHOW, kind: 'other', display_name: 'live-verify director 2' })
const claim2 = await call(dir2, 'claim_direction', { ...auth(reg2), takeover: true })
ok('takeover bumps epoch', claim2.epoch > claim1.epoch, { claim1, claim2 })

const stale = await call(dir1, 'create_task', {
  ...auth(reg1), epoch: claim1.epoch, title: 'should fail', brief: 'stale epoch',
})
ok('old director superseded', stale.status === 'superseded', stale)

// board + callboard API
const board = await call(dir2, 'get_board', { ...auth(reg2) })
ok('get_board', JSON.stringify(board).includes(SHOW))
const state = await fetch(`${URL_BASE}/api/shows/${SHOW}/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })
const stateJson = await state.json() as any
ok('callboard state API', state.status === 200 && Array.isArray(stateJson.members) && stateJson.members.length >= 3)
const page = await fetch(`${URL_BASE}/?token=${TOKEN}`, { redirect: 'follow' })
ok('callboard page', page.status === 200 && (await page.text()).toLowerCase().includes('<html'))
const unauth = await fetch(`${URL_BASE}/api/shows`)
ok('unauth rejected', unauth.status === 401)

if (WORKER_TOKEN) {
  const workerOnly = await connect('worker-token-only', WORKER_TOKEN)
  const regWo = await call(workerOnly, 'register', { show: SHOW, kind: 'other', display_name: 'worker-token probe' })
  const forbidden = await call(workerOnly, 'claim_direction', { ...auth(regWo), takeover: true })
  ok('worker token cannot claim_direction', forbidden.status === 'forbidden', forbidden)
  const apiWrite = await fetch(`${URL_BASE}/api/shows/${SHOW}/direction/clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WORKER_TOKEN}` },
  })
  ok('worker token cannot mutate /api', apiWrite.status === 403)
  await workerOnly.close()
} else {
  console.log('SKIP  worker-token checks (set SR_WORKER_TOKEN to exercise dual-token)')
}

await Promise.all([dir1, dir2, worker].map(c => c.close()))
console.log('\nLive verify complete.')
