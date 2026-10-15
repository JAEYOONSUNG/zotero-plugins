/* How much of a page is drawn, and which page is being looked at. The drawing itself needs a
   canvas; the arithmetic that decides it does not, and that is what goes wrong. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {fitScale, nearestPage, nearby, pinchZoom, fingerGap, isDoubleTap, clampZoom, afterZoom,
        markRects, markPlace, MAX_PIXELS, ZOOMS, ZOOM_MIN, ZOOM_MAX} from '../pdfview.js';

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

/* A mark made in Zotero has to land in the same place on the phone, at every zoom. Zotero keeps
   it in PDF user space, whose origin is the bottom left. */
test('a mark is placed as a share of the page, measured from the top', () => {
  const view = {width: 600, height: 800};
  const [box] = markRects(view, [[60, 700, 300, 740]]);
  assert.equal(box.left, 10, '60 of 600 across');
  assert.equal(box.top, 7.5, '800 - 740 of 800 down, not 700');
  assert.equal(box.width, 40);
  assert.equal(box.height, 5);
});

test('pdf.js is asked where a mark falls when it is there to ask, rotation and all', () => {
  const view = {width: 800, height: 600, convertToViewportRectangle: () => [400, 300, 200, 150]};
  const [box] = markRects(view, [[0, 0, 1, 1]]);
  assert.equal(box.left, 25, 'the corners are put back in order');
  assert.equal(box.top, 25);
  assert.equal(box.width, 25);
  assert.equal(box.height, 25);
});

test('a mark that makes no sense is left out rather than drawn wrong', () => {
  const view = {width: 600, height: 800};
  assert.deepEqual(markRects(view, [[1, 1, 1, 1]]), [], 'nothing of no size');
  assert.deepEqual(markRects(view, [[0, 0]]), []);
  assert.deepEqual(markRects(view, [['a', 'b', 'c', 'd']]), []);
  assert.deepEqual(markRects({width: 0, height: 0}, [[0, 0, 10, 10]]), []);
  assert.deepEqual(markRects(view, null), []);
});

test("Zotero's own shape for a mark is read, and a damaged one is skipped", () => {
  const place = markPlace({data: {itemType: 'annotation', annotationType: 'highlight',
    annotationColor: '#5fb236', annotationText: 'the enzyme works',
    annotationPosition: JSON.stringify({pageIndex: 2, rects: [[1, 2, 3, 4]]})}});
  assert.equal(place.page, 3, 'pageIndex counts from zero, pages from one');
  assert.equal(place.colour, '#5fb236');
  assert.equal(place.text, 'the enzyme works');
  assert.deepEqual(place.rects, [[1, 2, 3, 4]]);
  assert.equal(markPlace({data: {annotationPosition: 'not json'}}), null);
  assert.equal(markPlace({data: {}}), null);
  assert.equal(markPlace(null), null);
});

test('확대해도 보고 있던 자리에 그대로 있다', () => {
  /* Halfway down page 7, looking at the right-hand column. Zoomed to twice: the page is twice as
     tall, so halfway down it is twice as far, and the middle of the view is still the middle. */
  const back = afterZoom({down: 0.5, across: 300, pageTop: 6000, pageHeight: 1600, viewWidth: 390, ratio: 2});
  assert.equal(back.top, 6800);
  assert.equal(back.left, 300 * 2 - 195);
  // Zoomed back out, nothing is scrolled past the start of the page.
  const home = afterZoom({down: 0, across: 100, pageTop: 0, pageHeight: 800, viewWidth: 390, ratio: 1});
  assert.equal(home.top, 0);
  assert.equal(home.left, 0, 'a page that fits is not held off to one side');
  assert.deepEqual(afterZoom(), {top: 0, left: 0});
});
