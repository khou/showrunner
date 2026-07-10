import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const URL_BASE = process.env.SR_URL ?? (() => { throw new Error('set SR_URL to your deployment, e.g. SR_URL=https://my-app.fly.dev') })()
const TOKEN = process.env.SR_TOKEN ?? readFileSync(`${homedir()}/.showrunner-token`, 'utf8').trim()

async function connect(name: string) {
  const client = new Client({ name, version: '0.0.1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
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

const SHOW = process.env.SR_SHOW ?? `verify-${Date.now() % 100000}`
const dir1 = await connect('director-1')
const reg1 = await call(dir1, 'register', { show: SHOW, kind: 'other', display_name: 'live-verify director' })
ok('register director', !!reg1.member_id && typeof reg1.protocol === 'string')

const claim1 = await call(dir1, 'claim_direction', { member_id: reg1.member_id, takeover: true })
ok('claim_direction', typeof claim1.epoch === 'number')

const t1 = await call(dir1, 'create_task', {
  member_id: reg1.member_id, epoch: claim1.epoch,
  title: 'Live verify: say hello',
  brief: 'Synthetic task from live-verify script. Complete immediately.',
  priority: 5,
})
ok('create_task', !!t1.task_id, t1)

const worker = await connect('worker-1')
const regW = await call(worker, 'register', { show: SHOW, kind: 'other', display_name: 'live-verify worker' })
const gotTask = await call(worker, 'await_work', { member_id: regW.member_id })
ok('worker await_work -> task', gotTask.status === 'task' && gotTask.task?.id === t1.task_id, gotTask)

const done = await call(worker, 'update_task', {
  member_id: regW.member_id, task_id: t1.task_id, status: 'completed',
  note: 'hello from live verify',
  artifacts: [{ kind: 'text', text: 'done' }],
})
ok('update_task completed', done.task?.status === 'completed' || done.status === 'completed', done)

const review = await call(dir1, 'await_work', { member_id: reg1.member_id })
ok('director await_work -> review', review.status === 'review', review)

// long-poll wake: empty queue, create a task 1.5s in, expect resolution well under the hold
const pollP = call(worker, 'await_work', { member_id: regW.member_id })
const t0 = Date.now()
const lateCreateP = new Promise<any>(resolve => setTimeout(() => {
  resolve(call(dir1, 'create_task', {
    member_id: reg1.member_id, epoch: claim1.epoch,
    title: 'Live verify: long-poll wake', brief: 'Second synthetic task.',
  }))
}, 1500)).catch(e => ({ error: String(e) }))
const woke = await pollP
const dt = Date.now() - t0
const lateCreate = await lateCreateP
ok('mid-poll create_task', !!lateCreate.task_id, lateCreate)
ok(`long-poll wake (<6s, got ${dt}ms)`, woke.status === 'task' && dt < 6000, woke)
await call(worker, 'update_task', { member_id: regW.member_id, task_id: woke.task.id, status: 'completed', note: 'done' })

// takeover: second director; old epoch must be superseded
const dir2 = await connect('director-2')
const reg2 = await call(dir2, 'register', { show: SHOW, kind: 'other', display_name: 'live-verify director 2' })
const claim2 = await call(dir2, 'claim_direction', { member_id: reg2.member_id, takeover: true })
ok('takeover bumps epoch', claim2.epoch > claim1.epoch, { claim1, claim2 })

const stale = await call(dir1, 'create_task', {
  member_id: reg1.member_id, epoch: claim1.epoch, title: 'should fail', brief: 'stale epoch',
})
ok('old director superseded', stale.status === 'superseded', stale)

// board + callboard API
const board = await call(dir2, 'get_board', { member_id: reg2.member_id })
ok('get_board', JSON.stringify(board).includes(SHOW))
const state = await fetch(`${URL_BASE}/api/shows/${SHOW}/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })
const stateJson = await state.json() as any
ok('callboard state API', state.status === 200 && Array.isArray(stateJson.members) && stateJson.members.length >= 3)
const page = await fetch(`${URL_BASE}/?token=${TOKEN}`, { redirect: 'follow' })
ok('callboard page', page.status === 200 && (await page.text()).toLowerCase().includes('<html'))
const unauth = await fetch(`${URL_BASE}/api/shows`)
ok('unauth rejected', unauth.status === 401)

await Promise.all([dir1, dir2, worker].map(c => c.close()))
console.log('\nLive verify complete.')
