import { test } from 'node:test';
import assert from 'node:assert/strict';

import { serializeParams, parseShareParams } from '../../assets/lib/share-params.js';
import { calculateCost } from '../../assets/lib/cost-calculator.js';

const full = {
    mode: 'advanced',
    filamentWeightG: '50', spoolPriceEur: '22,5', spoolWeightG: '1000', purgeG: '4',
    durationHours: '2', durationMinutes: '30',
    powerW: '95', kwhPriceEur: '0,2516',
    printerPriceEur: '399', lifespanH: '5000', consumablesEurPerH: '0,05',
    failureRatePct: '5',
    prepMin: '10', postMin: '15', hourlyRateEur: '15',
    extrasEur: '1,5',
    marginPct: '30', microEnabled: true, microRatePct: '12',
    printer: 'bambu-a1',
};

test('round trip: every field survives, decimals come back with a dot', () => {
    const restored = parseShareParams(serializeParams(full));
    assert.deepEqual(restored, {
        ...full,
        spoolPriceEur: '22.5', kwhPriceEur: '0.2516', consumablesEurPerH: '0.05', extrasEur: '1.5',
    });
});

test('a restored link gives the same calculation as the original form', () => {
    const original = calculateCost(full);
    const restored = calculateCost(parseShareParams(serializeParams(full)));
    assert.deepEqual(restored, original);
});

test('the leading "?" is optional when parsing', () => {
    const query = serializeParams(full);
    assert.deepEqual(parseShareParams('?' + query), parseShareParams(query));
});

test('the serialized query has no comma and no unnecessary noise', () => {
    const query = serializeParams(full);
    assert.ok(!query.includes('%2C') && !query.includes(','));
    assert.match(query, /(^|&)m=a(&|$)/);
    assert.match(query, /(^|&)micro=1(&|$)/);
});

test('simple mode and micro off are serialized', () => {
    const restored = parseShareParams(serializeParams({ mode: 'simple', microEnabled: false }));
    assert.equal(restored.mode, 'simple');
    assert.equal(restored.microEnabled, false);
});

test('empty fields stay empty, invalid input is kept as typed', () => {
    const restored = parseShareParams(serializeParams({ extrasEur: '', powerW: 'abc', marginPct: ' -3 ' }));
    assert.equal(restored.extrasEur, '');
    assert.equal(restored.powerW, 'abc');
    assert.equal(restored.marginPct, '-3');
});

test('missing params are simply absent (defaults stay in place)', () => {
    assert.deepEqual(parseShareParams(''), {});
    assert.equal(serializeParams({}), '');
    assert.deepEqual(parseShareParams('w=10'), { filamentWeightG: '10' });
});

test('unknown keys, bad mode and bad printer id are ignored', () => {
    const restored = parseShareParams('m=x&evil=1&__proto__=2&pr=Bad%20Id%3Cscript%3E&w=5');
    assert.deepEqual(restored, { filamentWeightG: '5' });
});

test('overlong values are refused', () => {
    assert.deepEqual(parseShareParams('w=' + '9'.repeat(31)), {});
    assert.deepEqual(parseShareParams('w=' + '9'.repeat(30)), { filamentWeightG: '9'.repeat(30) });
});

test('serialization is deterministic regardless of key order in the input', () => {
    const reversed = Object.fromEntries(Object.entries(full).reverse());
    assert.equal(serializeParams(reversed), serializeParams(full));
});
