import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDecimal, formatEuro, formatPercent } from '../../assets/lib/number-format.js';

test('parseDecimal: empty-ish values are 0', () => {
    for (const input of ['', '   ', null, undefined]) {
        assert.equal(parseDecimal(input), 0);
    }
});

test('parseDecimal: accepts comma and dot decimals', () => {
    assert.equal(parseDecimal('12,5'), 12.5);
    assert.equal(parseDecimal('12.5'), 12.5);
    assert.equal(parseDecimal(',5'), 0.5);
    assert.equal(parseDecimal('7'), 7);
    assert.equal(parseDecimal(' 3,25 '), 3.25);
});

test('parseDecimal: accepts spaces as thousands separators', () => {
    assert.equal(parseDecimal('1 234,5'), 1234.5);
    assert.equal(parseDecimal('1 234'), 1234);
    assert.equal(parseDecimal('1 234,5'), 1234.5);
});

test('parseDecimal: passes negatives through (validation is the caller\'s job)', () => {
    assert.equal(parseDecimal('-3,5'), -3.5);
    assert.equal(parseDecimal(-2), -2);
});

test('parseDecimal: numbers pass through, non-finite become NaN', () => {
    assert.equal(parseDecimal(4.2), 4.2);
    assert.ok(Number.isNaN(parseDecimal(Infinity)));
    assert.ok(Number.isNaN(parseDecimal(NaN)));
});

test('parseDecimal: garbage and ambiguous input is NaN', () => {
    for (const input of ['abc', '12abc', '1,2,3', '1.234,56', '--1', '1e3', {}, []]) {
        assert.ok(Number.isNaN(parseDecimal(input)), `expected NaN for ${JSON.stringify(input)}`);
    }
});

// Intl output uses no-break spaces; normalise them for readable assertions.
const plain = (text) => text.replace(/[  ]/g, ' ');

test('formatEuro: fr-FR format with 2 decimals', () => {
    assert.equal(plain(formatEuro(1234.5)), '1 234,50 €');
    assert.equal(plain(formatEuro(0)), '0,00 €');
});

test('formatEuro: rounds at display time only', () => {
    assert.equal(plain(formatEuro(1.005 + 0.0000001)), '1,01 €');
    assert.equal(plain(formatEuro(2.344999)), '2,34 €');
});

test('formatEuro: non-finite falls back to 0', () => {
    assert.equal(plain(formatEuro(NaN)), '0,00 €');
});

test('formatPercent: whole percent, fr-FR', () => {
    assert.equal(plain(formatPercent(0.456)), '46 %');
    assert.equal(plain(formatPercent(1)), '100 %');
    assert.equal(plain(formatPercent(0)), '0 %');
});

test('formatPercent: tiny positive share is "< 1 %", invalid is 0 %', () => {
    assert.equal(formatPercent(0.001), '< 1 %');
    assert.equal(plain(formatPercent(NaN)), '0 %');
    assert.equal(plain(formatPercent(-0.2)), '0 %');
});
