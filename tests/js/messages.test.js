import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calculateCost } from '../../assets/lib/cost-calculator.js';
import { errorMessage } from '../../assets/lib/messages.js';

test('every error code produced by the calculator has a French message', () => {
    const results = [
        calculateCost({ powerW: 'abc' }),
        calculateCost({ extrasEur: -1 }),
        calculateCost({ filamentWeightG: 10, spoolWeightG: 0 }),
        calculateCost({ printerPriceEur: 100, lifespanH: 0 }),
        calculateCost({ microEnabled: true, microRatePct: 100 }),
    ];
    const errors = results.flatMap((r) => r.errors);
    assert.equal(errors.length, 5);
    for (const error of errors) {
        const message = errorMessage(error);
        assert.match(message, /\S{3,}/);
        assert.notEqual(message, 'Valeur invalide.', `${error.field}:${error.code}`);
    }
});

test('field-specific wording wins over the generic one', () => {
    assert.match(errorMessage({ field: 'spoolWeightG', code: 'must_be_positive' }), /bobine/);
    assert.match(errorMessage({ field: 'extrasEur', code: 'must_be_positive' }), /supérieure à 0/);
});

test('unknown code falls back to a generic message', () => {
    assert.equal(errorMessage({ field: 'x', code: 'nope' }), 'Valeur invalide.');
});
