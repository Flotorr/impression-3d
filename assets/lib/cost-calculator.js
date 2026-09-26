// Pure 3D-printing cost calculation. No DOM, no rounding (rounding is display-only).
//
// Input values may be numbers or user-typed strings ("12,5"); empty means 0.
// Invalid values are counted as 0 and reported in `errors` (never thrown).

import { parseDecimal } from './number-format.js';

export const MODES = ['simple', 'advanced'];

// Fields read in each mode. Fields outside the active mode are ignored
// (neither validated nor used), so hidden inputs never produce errors.
const SIMPLE_FIELDS = [
    'filamentWeightG', 'spoolPriceEur', 'spoolWeightG',
    'durationHours', 'durationMinutes',
    'powerW', 'kwhPriceEur',
    'marginPct',
];
const ADVANCED_FIELDS = [
    ...SIMPLE_FIELDS,
    'purgeG',
    'printerPriceEur', 'lifespanH', 'consumablesEurPerH',
    'failureRatePct',
    'prepMin', 'postMin', 'hourlyRateEur',
    'extrasEur',
    'microRatePct',
];

// Order of cost lines in the result (also the order of the donut / breakdown).
export const LINE_KEYS = ['filament', 'purge', 'electricity', 'wear', 'failure', 'labor', 'extras'];

/**
 * Margin as a markup on cost: price = cost * (1 + margin).
 * Kept isolated so the definition of "margin" is easy to change.
 */
export function applyMargin(cost, marginPct) {
    return cost * (1 + marginPct / 100);
}

/**
 * Price to invoice so that, after social contributions computed on turnover,
 * the seller still nets `netPrice`: invoice * (1 - rate) = netPrice.
 */
export function grossUpForContributions(netPrice, ratePct) {
    return netPrice / (1 - ratePct / 100);
}

/**
 * @typedef {'invalid'|'negative'|'must_be_positive'|'too_high'} ErrorCode
 * @typedef {{field: string, code: ErrorCode}} FieldError
 */

/**
 * @param {Object} params raw form values, see SIMPLE_FIELDS / ADVANCED_FIELDS
 * @param {'simple'|'advanced'} [params.mode='advanced']
 * @param {boolean} [params.microEnabled=false] advanced only
 */
export function calculateCost(params = {}) {
    const mode = params.mode === 'simple' ? 'simple' : 'advanced';
    const advanced = mode === 'advanced';
    const activeFields = advanced ? ADVANCED_FIELDS : SIMPLE_FIELDS;

    /** @type {FieldError[]} */
    const errors = [];
    const v = {};
    for (const field of activeFields) {
        const parsed = parseDecimal(params[field]);
        if (Number.isNaN(parsed)) {
            errors.push({ field, code: 'invalid' });
            v[field] = 0;
        } else if (parsed < 0) {
            errors.push({ field, code: 'negative' });
            v[field] = 0;
        } else {
            v[field] = parsed;
        }
    }
    // Fields outside the active mode read as 0.
    for (const field of ADVANCED_FIELDS) {
        v[field] ??= 0;
    }

    const durationH = v.durationHours + v.durationMinutes / 60;

    // Filament (+ purge): grams * spool price / spool weight.
    const filamentGrams = v.filamentWeightG;
    const purgeGrams = advanced ? v.purgeG : 0;
    let pricePerGram = 0;
    if (filamentGrams + purgeGrams > 0 && v.spoolWeightG === 0 && !hasError(errors, 'spoolWeightG')) {
        errors.push({ field: 'spoolWeightG', code: 'must_be_positive' });
    } else if (v.spoolWeightG > 0) {
        pricePerGram = v.spoolPriceEur / v.spoolWeightG;
    }
    const filament = filamentGrams * pricePerGram;
    const purge = purgeGrams * pricePerGram;

    // Electricity: W * h / 1000 * price per kWh.
    const electricity = (v.powerW * durationH / 1000) * v.kwhPriceEur;

    // Machine wear: printer price / lifespan * hours, plus consumables per hour.
    let wear = 0;
    if (advanced) {
        if (v.printerPriceEur > 0 && v.lifespanH === 0 && !hasError(errors, 'lifespanH')) {
            errors.push({ field: 'lifespanH', code: 'must_be_positive' });
        }
        const depreciationPerHour = v.lifespanH > 0 ? v.printerPriceEur / v.lifespanH : 0;
        wear = (depreciationPerHour + v.consumablesEurPerH) * durationH;
    }

    // Failure rate applies to production cost only (not labor or extras).
    const productionCost = filament + purge + electricity + wear;
    const failure = advanced ? productionCost * v.failureRatePct / 100 : 0;

    const labor = advanced ? (v.prepMin + v.postMin) / 60 * v.hourlyRateEur : 0;
    const extras = advanced ? v.extrasEur : 0;

    const total = productionCost + failure + labor + extras;

    const suggestedPrice = applyMargin(total, v.marginPct);

    // Micro-entrepreneur: gross up the price so contributions don't eat the margin.
    let micro = null;
    if (advanced && params.microEnabled) {
        if (v.microRatePct >= 100) {
            errors.push({ field: 'microRatePct', code: 'too_high' });
        } else {
            const invoicePrice = grossUpForContributions(suggestedPrice, v.microRatePct);
            micro = { invoicePrice, contributions: invoicePrice - suggestedPrice };
        }
    }

    return {
        mode,
        durationHours: durationH,
        lines: [
            { key: 'filament', amount: filament },
            { key: 'purge', amount: purge },
            { key: 'electricity', amount: electricity },
            { key: 'wear', amount: wear },
            { key: 'failure', amount: failure },
            { key: 'labor', amount: labor },
            { key: 'extras', amount: extras },
        ],
        productionCost,
        total,
        marginAmount: suggestedPrice - total,
        suggestedPrice,
        micro,
        errors,
        hasErrors: errors.length > 0,
    };
}

function hasError(errors, field) {
    return errors.some((error) => error.field === field);
}
