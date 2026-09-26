import { test } from 'node:test';
import assert from 'node:assert/strict';

import { donutSegments, DONUT_RADIUS } from '../../assets/lib/donut.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test('circumference of the ring is 100 units', () => {
    near(2 * Math.PI * DONUT_RADIUS, 100);
});

test('no positive amount => no segments', () => {
    assert.deepEqual(donutSegments([]), []);
    assert.deepEqual(donutSegments([{ key: 'a', amount: 0 }, { key: 'b', amount: 0 }]), []);
});

test('a single line fills the whole ring, starting at 12 o\'clock', () => {
    const [segment] = donutSegments([{ key: 'a', amount: 3 }, { key: 'b', amount: 0 }]);
    assert.equal(segment.key, 'a');
    near(segment.share, 1);
    near(segment.dash, 100);
    near(segment.gap, 0);
    near(segment.offset, 25);
});

test('segments follow each other and add up to the full ring', () => {
    const segments = donutSegments([
        { key: 'a', amount: 1 },
        { key: 'zero', amount: 0 },
        { key: 'b', amount: 3 },
    ]);
    assert.deepEqual(segments.map((s) => s.key), ['a', 'b']);
    near(segments[0].dash, 25);
    near(segments[0].offset, 25);
    near(segments[1].dash, 75);
    near(segments[1].offset, 0); // 25 - 25
    near(segments.reduce((sum, s) => sum + s.share, 0), 1);
    for (const s of segments) {
        near(s.dash + s.gap, 100);
    }
});

test('invalid amounts are ignored', () => {
    const segments = donutSegments([
        { key: 'a', amount: NaN },
        { key: 'b', amount: -2 },
        { key: 'c', amount: 2 },
    ]);
    assert.deepEqual(segments.map((s) => s.key), ['c']);
});
