import assert from 'node:assert/strict'
import test from 'node:test'
import { appendImageDrawingPoint, isStraightImageGesture } from './image-drawing.ts'
test('all image preview adapters share freehand, Shift line and explicit line semantics', () => {
  assert.equal(isStraightImageGesture('freehand',false),false)
  assert.equal(isStraightImageGesture('freehand',true),true)
  assert.equal(isStraightImageGesture('line',false),true)
  assert.equal(isStraightImageGesture('rectangle',true),false)
  const points=[[1,2]]
  appendImageDrawingPoint(points,[3,4],true)
  appendImageDrawingPoint(points,[5,6],true)
  assert.deepEqual(points,[[1,2],[5,6]])
  const stroke=[{x:1,y:2}]
  appendImageDrawingPoint(stroke,{x:3,y:4},false)
  appendImageDrawingPoint(stroke,{x:5,y:6},false)
  assert.equal(stroke.length,3)
})
