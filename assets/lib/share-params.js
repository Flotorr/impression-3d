// Serialize the form state to a URL query string and back, so a result can be shared.
// Pure: no DOM, no window.location. Short keys keep links readable.

import { parseDecimal } from './number-format.js';

// Form field name => short query-string key.
const NUMERIC_KEYS = {
    filamentWeightG: 'w',
    spoolPriceEur: 'sp',
    spoolWeightG: 'sw',
    purgeG: 'pg',
    durationHours: 'h',
    durationMinutes: 'min',
    powerW: 'pw',
    kwhPriceEur: 'kwh',
    printerPriceEur: 'pp',
    lifespanH: 'life',
    consumablesEurPerH: 'cons',
    failureRatePct: 'fail',
    prepMin: 'prep',
    postMin: 'post',
    hourlyRateEur: 'rate',
    extrasEur: 'ex',
    marginPct: 'mg',
    microRatePct: 'mrate',
};
const MODE_KEY = 'm';
const MICRO_KEY = 'micro';
const PRINTER_KEY = 'pr';

const MODE_CODES = { simple: 's', advanced: 'a' };
const MODE_FROM_CODE = { s: 'simple', a: 'advanced' };

// Shared links come from outside: cap what we accept.
const MAX_VALUE_LENGTH = 30;
const PRINTER_ID = /^[a-z0-9-]{1,60}$/;

/**
 * @param {Object} params raw form values (same shape as calculateCost input, plus `printer`)
 * @returns {string} query string without the leading "?" (empty string if nothing to share)
 */
export function serializeParams(params) {
    const query = new URLSearchParams();

    if (params.mode in MODE_CODES) {
        query.set(MODE_KEY, MODE_CODES[params.mode]);
    }
    for (const [field, key] of Object.entries(NUMERIC_KEYS)) {
        if (params[field] !== undefined && params[field] !== null) {
            query.set(key, normalizeNumber(params[field]));
        }
    }
    if (params.microEnabled !== undefined) {
        query.set(MICRO_KEY, params.microEnabled ? '1' : '0');
    }
    if (typeof params.printer === 'string' && PRINTER_ID.test(params.printer)) {
        query.set(PRINTER_KEY, params.printer);
    }

    return query.toString();
}

/**
 * Read shared parameters from a query string ("?w=50&…" or "w=50&…").
 * Unknown keys and malformed values are ignored. Numeric values are returned as
 * strings with a dot decimal; the caller decides how to display them.
 *
 * @param {string} search
 * @returns {Object} partial params: only the fields present and acceptable in the query
 */
export function parseShareParams(search) {
    const query = new URLSearchParams(search);
    const params = {};

    const mode = MODE_FROM_CODE[query.get(MODE_KEY)];
    if (mode) {
        params.mode = mode;
    }
    for (const [field, key] of Object.entries(NUMERIC_KEYS)) {
        const value = query.get(key);
        if (value !== null && value.length <= MAX_VALUE_LENGTH) {
            params[field] = value;
        }
    }
    if (query.has(MICRO_KEY)) {
        params.microEnabled = query.get(MICRO_KEY) === '1';
    }
    const printer = query.get(PRINTER_KEY);
    if (printer !== null && PRINTER_ID.test(printer)) {
        params.printer = printer;
    }

    return params;
}

// "12,5" => "12.5" so links do not contain a comma; unparsable input is kept as typed
// (trimmed) so a shared link reproduces the same validation errors.
function normalizeNumber(value) {
    const text = String(value).trim();
    const parsed = parseDecimal(text);

    return Number.isNaN(parsed) ? text : text === '' ? '' : String(parsed);
}
