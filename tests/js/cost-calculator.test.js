import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateCost,
    applyMargin,
    grossUpForContributions,
    LINE_KEYS,
} from '../../assets/lib/cost-calculator.js';

const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} !~ ${expected}`);
const line = (result, key) => result.lines.find((l) => l.key === key).amount;
const errorFor = (result, field) => result.errors.find((e) => e.field === field);

// A simple, hand-checkable base case: 100 g from a 1000 g / 20 € spool (0.02 €/g),
// 2 h at 100 W with 0.25 €/kWh.
const base = {
    mode: 'advanced',
    filamentWeightG: 100, spoolPriceEur: 20, spoolWeightG: 1000,
    durationHours: 2, durationMinutes: 0,
    powerW: 100, kwhPriceEur: 0.25,
};

test('filament: grams * spool price / spool weight', () => {
    const r = calculateCost(base);
    near(line(r, 'filament'), 2);
});

test('purge: extra grams priced like filament, shown as its own line', () => {
    const r = calculateCost({ ...base, purgeG: 25 });
    near(line(r, 'purge'), 0.5);
    near(line(r, 'filament'), 2);
    near(r.total, 2 + 0.5 + 0.05);
});

test('electricity: W * h / 1000 * kWh price', () => {
    const r = calculateCost(base);
    near(line(r, 'electricity'), 0.05);
});

test('duration: hours + minutes', () => {
    const r = calculateCost({ ...base, durationHours: 1, durationMinutes: 30 });
    near(r.durationHours, 1.5);
    near(line(r, 'electricity'), 100 * 1.5 / 1000 * 0.25);
});

test('duration: minutes over 59 are simply added', () => {
    const r = calculateCost({ ...base, durationHours: 0, durationMinutes: 90 });
    near(r.durationHours, 1.5);
    assert.equal(r.hasErrors, false);
});

test('wear: printer price / lifespan * hours', () => {
    const r = calculateCost({ ...base, printerPriceEur: 500, lifespanH: 5000 });
    near(line(r, 'wear'), 0.1 * 2);
});

test('wear: consumables per hour are added', () => {
    const r = calculateCost({ ...base, printerPriceEur: 500, lifespanH: 5000, consumablesEurPerH: 0.05 });
    near(line(r, 'wear'), (0.1 + 0.05) * 2);
});

test('failure rate applies to production cost only', () => {
    const r = calculateCost({
        ...base, printerPriceEur: 500, lifespanH: 5000,
        failureRatePct: 10, prepMin: 60, hourlyRateEur: 10, extrasEur: 3,
    });
    const production = 2 + 0.05 + 0.2;
    near(r.productionCost, production);
    near(line(r, 'failure'), production * 0.1);
    // labor and extras are not increased by the failure rate
    near(line(r, 'labor'), 10);
    near(line(r, 'extras'), 3);
    near(r.total, production * 1.1 + 10 + 3);
});

test('labor: (prep + post) minutes * hourly rate', () => {
    const r = calculateCost({ ...base, prepMin: 15, postMin: 30, hourlyRateEur: 12 });
    near(line(r, 'labor'), 0.75 * 12);
});

test('extras are added as-is', () => {
    const r = calculateCost({ ...base, extrasEur: 1.5 });
    near(line(r, 'extras'), 1.5);
    near(r.total, 2 + 0.05 + 1.5);
});

test('margin: markup on total cost', () => {
    const r = calculateCost({ ...base, marginPct: 50 });
    near(r.suggestedPrice, r.total * 1.5);
    near(r.marginAmount, r.total * 0.5);
    near(applyMargin(10, 30), 13);
});

test('margin at 0 leaves the price equal to the cost', () => {
    const r = calculateCost(base);
    near(r.suggestedPrice, r.total);
    assert.equal(r.micro, null);
});

test('micro-entrepreneur: invoice price keeps the margin after contributions', () => {
    const r = calculateCost({ ...base, marginPct: 50, microEnabled: true, microRatePct: 12 });
    near(r.micro.invoicePrice, r.suggestedPrice / 0.88);
    // after paying contributions on turnover, the seller nets the suggested price
    near(r.micro.invoicePrice * (1 - 0.12), r.suggestedPrice);
    near(r.micro.contributions, r.micro.invoicePrice - r.suggestedPrice);
    near(grossUpForContributions(88, 12), 100);
});

test('micro-entrepreneur: off by default and when disabled', () => {
    assert.equal(calculateCost({ ...base, microRatePct: 12 }).micro, null);
    assert.equal(calculateCost({ ...base, microEnabled: false, microRatePct: 12 }).micro, null);
});

test('micro-entrepreneur: rate >= 100% is an error and yields no invoice price', () => {
    const r = calculateCost({ ...base, microEnabled: true, microRatePct: 100 });
    assert.equal(r.micro, null);
    assert.equal(errorFor(r, 'microRatePct').code, 'too_high');
});

test('simple mode: only filament + electricity (+ margin), advanced fields ignored', () => {
    const r = calculateCost({
        ...base, mode: 'simple', marginPct: 100,
        purgeG: 50, printerPriceEur: 500, lifespanH: 5000, consumablesEurPerH: 1,
        failureRatePct: 50, prepMin: 60, hourlyRateEur: 20, extrasEur: 9,
        microEnabled: true, microRatePct: 20,
    });
    near(r.total, 2 + 0.05);
    near(r.suggestedPrice, (2 + 0.05) * 2);
    assert.equal(r.micro, null);
    for (const key of ['purge', 'wear', 'failure', 'labor', 'extras']) {
        assert.equal(line(r, key), 0, key);
    }
});

test('simple mode: invalid hidden advanced fields do not raise errors', () => {
    const r = calculateCost({ ...base, mode: 'simple', extrasEur: 'abc', prepMin: -5 });
    assert.equal(r.hasErrors, false);
});

test('result exposes every line key in a stable order', () => {
    assert.deepEqual(calculateCost(base).lines.map((l) => l.key), LINE_KEYS);
});

test('empty and missing fields count as 0, without errors', () => {
    const r = calculateCost({});
    assert.equal(r.total, 0);
    assert.equal(r.suggestedPrice, 0);
    assert.equal(r.hasErrors, false);
    const blank = calculateCost({ ...base, extrasEur: '', prepMin: null, hourlyRateEur: undefined });
    assert.equal(blank.hasErrors, false);
    near(blank.total, 2.05);
});

test('comma decimals are accepted in string input', () => {
    const r = calculateCost({ ...base, spoolPriceEur: '22,50', kwhPriceEur: '0,2516' });
    near(line(r, 'filament'), 100 * 22.5 / 1000);
    near(line(r, 'electricity'), 0.1 * 2 * 0.2516);
});

test('negative values: error reported, field counted as 0', () => {
    const r = calculateCost({ ...base, extrasEur: -4 });
    assert.equal(errorFor(r, 'extrasEur').code, 'negative');
    assert.equal(r.hasErrors, true);
    near(line(r, 'extras'), 0);
    near(r.total, 2.05);
});

test('non-numeric values: error reported, field counted as 0', () => {
    const r = calculateCost({ ...base, powerW: 'abc' });
    assert.equal(errorFor(r, 'powerW').code, 'invalid');
    near(line(r, 'electricity'), 0);
});

test('spool weight 0 with filament used: error, no division by zero', () => {
    const r = calculateCost({ ...base, spoolWeightG: 0 });
    assert.equal(errorFor(r, 'spoolWeightG').code, 'must_be_positive');
    assert.ok(Number.isFinite(r.total));
    near(line(r, 'filament'), 0);
});

test('spool weight 0 without any filament used: no error', () => {
    const r = calculateCost({ ...base, filamentWeightG: 0, spoolWeightG: 0 });
    assert.equal(r.hasErrors, false);
});

test('a negative spool weight is reported once, as negative', () => {
    const r = calculateCost({ ...base, spoolWeightG: -1 });
    assert.equal(r.errors.filter((e) => e.field === 'spoolWeightG').length, 1);
    assert.equal(errorFor(r, 'spoolWeightG').code, 'negative');
});

test('lifespan 0 with a printer price: error, no division by zero', () => {
    const r = calculateCost({ ...base, printerPriceEur: 500, lifespanH: 0 });
    assert.equal(errorFor(r, 'lifespanH').code, 'must_be_positive');
    assert.ok(Number.isFinite(r.total));
    near(line(r, 'wear'), 0);
});

test('lifespan 0 without printer price: no error', () => {
    const r = calculateCost({ ...base, printerPriceEur: 0, lifespanH: 0 });
    assert.equal(r.hasErrors, false);
});

test('no rounding in calculations: display rounding only', () => {
    const r = calculateCost({ ...base, filamentWeightG: 1, spoolPriceEur: 19.99, spoolWeightG: 1000 });
    assert.equal(line(r, 'filament'), 1 * 19.99 / 1000);
});
