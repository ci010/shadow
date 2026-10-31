import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitFollowingTimeline, prependScrollTop, reconcileTimelineKeys, retainTimelineRollover, timelineBoundaryPositions, timelineCanPrepend, type TimelineSegment } from './conversation-timeline.ts'

test('preloaded segments survive live rollover and repeated snapshots retain each boundary once', () => {
  const oldest: TimelineSegment<string, string> = { id: 'old', previousId: 'older', messages: ['old summary', 'old tool'], decisions: ['old decision'] }
  const current = ['current summary', 'current answer']
  const loaded = retainTimelineRollover([oldest], current, ['current decision'], 'old', 'closed-current')
  assert.deepEqual(loaded.map(segment => segment.messages), [oldest.messages, current])
  assert.deepEqual([...timelineBoundaryPositions(loaded, 'closed-current')], [[0, ['older']], [2, ['old']], [4, ['closed-current']]])
  assert.equal(retainTimelineRollover(loaded, ['new answer'], [], 'closed-current', 'closed-current'), loaded)
  assert.equal(retainTimelineRollover(loaded, current, [], 'old', 'closed-current'), loaded)
  assert.deepEqual(retainTimelineRollover([], current, [], undefined, 'old'), [])
  assert.equal(loaded[0], oldest)
})

test('prepending adds height to the current viewport rather than the viewport at request admission', () => {
  assert.equal(prependScrollTop({ top: 140, height: 600 }, 1100), 640)
  assert.equal(prependScrollTop({ top: 80, height: 600 }, 1100), 580)
  assert.equal(prependScrollTop({ top: 80, height: 600 }, 500), 0)
})

test('the first version bounds older loading without evicting already loaded messages', () => {
  assert.equal(timelineCanPrepend([], 1999), true)
  assert.equal(timelineCanPrepend([], 2000), false)
  const segment = { id: 'old', previousId: null, messages: ['old'], decisions: [] }
  assert.equal(timelineCanPrepend(Array(8).fill(segment), 10), false)
  assert.equal(timelineCanPrepend(Array(7).fill(segment), 10), true)
})

test('persisted identity survives leading rows and distinguishes duplicate message instances', () => {
  const previous = [{role:'assistant', content:'A', timelineKey:'a'}, {role:'assistant', content:'A', timelineKey:'b'}, {role:'assistant', content:'tool()',toolCallId:'tool-one',timelineKey:'tool'}]
  const incoming = [{role:'user',content:'Leading summary'}, {role:'assistant',content:'A'}, {role:'assistant',content:'A'}, {role:'assistant',content:'updated tool()',toolCallId:'tool-one'}]
  assert.deepEqual(reconcileTimelineKeys(incoming, previous).map(message => message.timelineKey), [undefined,'a','b','tool'])
})

test('following latest prunes excess oldest segments without changing their retained identity', () => {
  const segments = Array.from({length:10}, (_, i) => ({id:String(i),previousId:String(i-1),messages:Array(300).fill('message'),decisions:[]}))
  const retained = limitFollowingTimeline(segments, 500)
  assert.deepEqual(retained.map(segment => segment.id), ['5','6','7','8','9'])
  assert.equal(retained[0], segments[5])
  assert.deepEqual(limitFollowingTimeline(segments, 2001), [])
})

test('a missed rollover never relabels retained messages as a different physical segment', () => {
  const segments = retainTimelineRollover([], ['visible message'], [], 'older', 'unseen-closed', 'actually-visible')
  assert.equal(segments[0].id, 'actually-visible')
  assert.deepEqual([...timelineBoundaryPositions(segments, 'unseen-closed')], [[0,['older']],[1,['unseen-closed']]])
})

test('empty physical segments retain every boundary including the trailing current join', () => {
  const segments = [{id:'empty-one',previousId:'old',messages:[],decisions:[]}, {id:'empty-two',previousId:'empty-one',messages:[],decisions:[]}]
  assert.deepEqual([...timelineBoundaryPositions(segments, 'empty-two')], [[0,['old','empty-one','empty-two']]])
})
