'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const focal = require('../app/focal-math');
const almost = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-7, message || `${actual} != ${expected}`);

test('phone and TV ship identical focal math', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../app/focal-math.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../service/public/focal-math.js'), 'utf8'));
});
test('null preserves legacy centered-horizontal top framing', () => {
  const result = focal.computeFrame({imageWidth: 2400, imageHeight: 3600, viewportWidth: 1920, viewportHeight: 1080, point: null});
  almost(result.baseLeft, 0); almost(result.baseTop, 0);
  assert.equal(result.objectPosition.y, 0);
  assert.equal(result.framingLabel, 'Original top framing');
});
test('feasible focal point is centered without extra cover crop', () => {
  const result = focal.computeFrame({imageWidth: 2400, imageHeight: 1800, viewportWidth: 1920, viewportHeight: 1080, point: {x: .5, y: .5}});
  almost(result.coverScale, .8); almost(result.anchor.x, 960); almost(result.anchor.y, 540);
  assert.equal(result.centered, true); assert.equal(result.clamped, false);
});
test('edge points use nearest safe placement with no forced extreme zoom', () => {
  const result = focal.computeFrame({imageWidth: 2400, imageHeight: 1800, viewportWidth: 1920, viewportHeight: 1080, point: {x: 0, y: 0}});
  almost(result.coverScale, .8); almost(result.anchor.x, 0); almost(result.anchor.y, 0);
  assert.equal(result.centered, false); assert.equal(result.clamped, true);
  assert.equal(result.framingLabel, 'Near edge · fixed');
});
test('every focal anchor remains fixed through zoom with no exposed edges', () => {
  for (const [iw, ih] of [[2400,1350],[2400,3600],[3840,1803],[1350,2400],[1000,1000],[4096,2000]]) {
    for (const [vw, vh] of [[1920,1080],[1280,720]]) {
      for (const x of [0,.01,.1,.25,.5,.75,.9,.99,1]) for (const y of [0,.01,.1,.25,.5,.75,.9,.99,1]) {
        const base = focal.computeFrame({imageWidth: iw,imageHeight: ih,viewportWidth: vw,viewportHeight: vh,point:{x,y}});
        for (const zoom of [1,1.015,1.03,1.05,1.08,1.2]) {
          const frame = focal.computeFrame({imageWidth: iw,imageHeight: ih,viewportWidth: vw,viewportHeight: vh,point:{x,y},zoom});
          almost(frame.left + x * frame.width, base.anchor.x, 'Focal X drifted');
          almost(frame.top + y * frame.height, base.anchor.y, 'Focal Y drifted');
          assert.ok(frame.left <= 1e-7 && frame.top <= 1e-7);
          assert.ok(frame.left + frame.width >= vw - 1e-7 && frame.top + frame.height >= vh - 1e-7);
          assert.ok(frame.anchor.x >= 0 && frame.anchor.x <= vw + 1e-7 && frame.anchor.y >= 0 && frame.anchor.y <= vh + 1e-7);
        }
      }
    }
  }
});
test('object-position reproduces the same crop as the shared frame math', () => {
  for (const point of [{x:0,y:0},{x:.4,y:.35},{x:.5,y:.5},{x:1,y:1}]) {
    const frame = focal.computeFrame({imageWidth:2400,imageHeight:3600,viewportWidth:1920,viewportHeight:1080,point});
    almost((1920-frame.baseWidth)*frame.objectPosition.x/100, frame.baseLeft);
    almost((1080-frame.baseHeight)*frame.objectPosition.y/100, frame.baseTop);
  }
});
test('contain editor rejects letterbox clicks and returns normalized photo coordinates', () => {
  const options = {rect:{left:10,top:20,width:1000,height:500},imageWidth:500,imageHeight:1000};
  assert.equal(focal.pointFromClient({...options,clientX:20,clientY:30}), null);
  assert.deepEqual(focal.pointFromClient({...options,clientX:510,clientY:270}), {x:.5,y:.5});
  assert.deepEqual(focal.pointFromClient({...options,clientX:385,clientY:20}), {x:0,y:0});
});
test('invalid dimensions, focal coordinates and zoom are rejected', () => {
  const options = {imageWidth:2400,imageHeight:1800,viewportWidth:1920,viewportHeight:1080,point:{x:.5,y:.5}};
  assert.throws(() => focal.computeFrame({...options,imageWidth:0}), RangeError);
  assert.throws(() => focal.computeFrame({...options,point:{x:-.1,y:.5}}), RangeError);
  assert.throws(() => focal.computeFrame({...options,point:{x:NaN,y:.5}}), RangeError);
  assert.throws(() => focal.computeFrame({...options,zoom:.99}), RangeError);
});
