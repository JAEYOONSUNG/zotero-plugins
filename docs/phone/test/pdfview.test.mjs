/* How much of a page is drawn, and which page is being looked at. The drawing itself needs a
   canvas; the arithmetic that decides it does not, and that is what goes wrong. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fitScale, nearestPage, nearby, pinchZoom, fingerGap, isDoubleTap, clampZoom,
        MAX_PIXELS, ZOOMS, ZOOM_MIN, ZOOM_MAX} from '../pdfview.js';

const A4 = {width: 595, height: 842};

test('a page is drawn to fill the column, sharper on a dense screen', () => {
  const plain = fitScale(A4, 390, {zoom: 1, density: 1});
  assert.ok(Math.abs(plain.css - 390 / 595) < 1e-9, 'it fits the column exactly');
  assert.equal(plain.canvas, plain.css);
  const retina = fitScale(A4, 390, {zoom: 1, density: 3});
  assert.equal(retina.css, plain.css, 'the page is the same size on screen');
  assert.ok(retina.canvas > plain.canvas, 'but there are more pixels in it');
  assert.ok(retina.canvas <= plain.css * 2 + 1e-9, 'and never more than twice over');
});

test('zooming in makes the page bigger, not just sharper', () => {
  const one = fitScale(A4, 390, {zoom: 1, density: 1});
  const two = fitScale(A4, 390, {zoom: 2, density: 1});
  assert.ok(Math.abs(two.css - one.css * 2) < 1e-9);
});

test('a canvas is never asked for more pixels than a phone will give', () => {
  const huge = fitScale({width: 2000, height: 3000}, 1200, {zoom: 3, density: 3});
  const pixels = 2000 * huge.canvas * 3000 * huge.canvas;
  assert.ok(pixels <= MAX_PIXELS * 1.001, `${Math.round(pixels)} pixels is within the cap`);
  assert.ok(huge.canvas > 0.1, 'and still something worth looking at');
});

test('the page being read is the one under the middle of the window', () => {
  const tops = [0, 900, 1800, 2700];
  assert.equal(nearestPage(tops, 0, 800), 1);
  assert.equal(nearestPage(tops, 700, 800), 2, 'most of the second page is showing');
  assert.equal(nearestPage(tops, 2700, 800), 4);
  assert.equal(nearestPage([], 0, 800), 1, 'nothing loaded is still page one');
});

test('only the pages around the reader are held, and never past the ends', () => {
  assert.deepEqual(nearby(5, 20), [4, 5, 6]);
  assert.deepEqual(nearby(1, 20), [1, 2]);
  assert.deepEqual(nearby(20, 20), [19, 20]);
  assert.deepEqual(nearby(1, 1), [1]);
  assert.ok(ZOOMS[0] === 1, 'the first zoom is the page as it fits');
});

test('two fingers moving apart zoom in, together zoom out, within bounds', () => {
  assert.equal(pinchZoom(1, 100, 200), 2);
  assert.equal(pinchZoom(2, 200, 100), 1);
  assert.equal(pinchZoom(1, 100, 10), ZOOM_MIN, 'it never goes below the page fitting the column');
  assert.equal(pinchZoom(3, 100, 900), ZOOM_MAX, 'and never past what a canvas can hold');
  assert.equal(pinchZoom(1.5, 0, 200), 1.5, 'a gap of nothing changes nothing');
  assert.equal(fingerGap([{clientX: 0, clientY: 0}, {clientX: 30, clientY: 40}]), 50);
  assert.equal(fingerGap([{clientX: 0, clientY: 0}]), 0, 'one finger is not a pinch');
});

test('a second tap in the same place soon after the first is a double tap', () => {
  const first = {at: 1000, x: 100, y: 200};
  assert.equal(isDoubleTap(first, {at: 1200, x: 104, y: 196}), true);
  assert.equal(isDoubleTap(first, {at: 1900, x: 100, y: 200}), false, 'too slow');
  assert.equal(isDoubleTap(first, {at: 1100, x: 300, y: 200}), false, 'too far');
  assert.equal(isDoubleTap(null, {at: 1, x: 0, y: 0}), false);
});

test('the buttons step through the named sizes from wherever a pinch left it', () => {
  // A viewer needs a DOM; the step itself is what matters, so it is checked against the ladder.
  const step = (from, dir) => {
    const above = ZOOMS.findIndex(z => z > from + 0.001);
    return dir > 0 ? (above < 0 ? ZOOMS[ZOOMS.length - 1] : ZOOMS[above])
                   : ZOOMS[Math.max(0, (above < 0 ? ZOOMS.length : above) - 2)];
  };
  assert.equal(step(1, 1), 1.25);
  assert.equal(step(1.37, 1), 1.5, 'from between two sizes it goes up to the next');
  assert.equal(step(1.37, -1), 1, 'and down to the one below');
  assert.equal(step(3, 1), 3, 'the top stays the top');
  assert.equal(step(1, -1), 1, 'and the bottom the bottom');
  assert.equal(clampZoom('x'), ZOOM_MIN);
});
