import assert from 'node:assert/strict'
import test from 'node:test'
import { i18n } from './i18n.ts'
import { formatWorkflowSchedule } from './workflow-schedule.ts'
import { workflowTargetSession, type WorkflowDefinition } from './workflows.ts'

test('intervals choose the largest exact unit and daily cron preserves wall time, in both locales', () => {
  try {
    i18n.global.locale.value = 'zh-CN'
    for (const [input, expected] of [['every 1800000ms','每30分钟'],['every60s','每1分钟'],['every 2h','每2小时'],['every 12h','每12小时'],['every 3d','每3天'],['every 90s','每90秒'],['every 1500ms','每1500毫秒'],['0 3 * * *','每天03:00']]) assert.equal(formatWorkflowSchedule(input!), expected)
    i18n.global.locale.value = 'en'
    assert.equal(formatWorkflowSchedule('every 60s'), 'Every 1 minute')
    assert.equal(formatWorkflowSchedule('every 120m'), 'Every 2 hours')
    assert.equal(formatWorkflowSchedule('0 3 * * *'), 'Daily at 03:00')
    for (const input of ['0 9 * * 1','*/15 1-5 * * 1,3','every 0s','every 1.5h','60 24 * * *','every 999999999999999999d']) assert.equal(formatWorkflowSchedule(input), input)
  } finally { i18n.global.locale.value = 'en' }
})
test('only explicit fixed targets get node links, never workflow IDs or fresh policy guesses', () => {
  const definition: WorkflowDefinition = { id:'not-a-session', revision:1, enabled:true, owner:'web:owner', source:{kind:'schedule',id:'clock'},nodes:[] }
  assert.equal(workflowTargetSession({kind:'schedule-action', action:'session',job:{target:{sessionId:'web:fixed'}}},definition),'web:fixed')
  assert.equal(workflowTargetSession({kind:'inbox'},definition),'web:owner')
  for (const node of [{kind:'schedule-action',action:'agent',job:{session:'fresh'}},{kind:'schedule-action',action:'program',job:{source:'learning'}},{kind:'record'},{kind:'host-action'}]) assert.equal(workflowTargetSession(node,definition),undefined)
})
