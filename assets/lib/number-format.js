// Pure helpers for reading and displaying numbers the French way.
// No DOM access: usable from the Stimulus controller and from `node --test`.

const euroFormatter = new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

// Spaces (regular, no-break, narrow no-break) are accepted as thousands separators.
const SPACES = /[\s  ]/g;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Parse a user-typed number. Accepts "12,5" and "12.5".
 * Empty / null / undefined => 0. Anything unparsable => NaN.
 * Ambiguous inputs such as "1.234,56" are rejected (NaN) on purpose.
 *
 * @param {string|number|null|undefined} input
 * @returns {number}
 */
export function parseDecimal(input) {
    if (input === null || input === undefined) {
        return 0;
    }
    if (typeof input === 'number') {
        return Number.isFinite(input) ? input : NaN;
    }
    if (typeof input !== 'string') {
        return NaN;
    }

    const cleaned = input.replace(SPACES, '').replace(',', '.');
    if (cleaned === '') {
        return 0;
    }

    return DECIMAL.test(cleaned) ? Number(cleaned) : NaN;
}

const percentFormatter = new Intl.NumberFormat('fr-FR', {
    style: 'percent',
    maximumFractionDigits: 0,
});

/**
 * Format a share (0..1) as a whole percent, e.g. 0.456 => "46 %".
 * A positive share that would round to 0 reads "< 1 %" rather than a misleading "0 %".
 *
 * @param {number} share
 * @returns {string}
 */
export function formatPercent(share) {
    if (!Number.isFinite(share) || share <= 0) {
        return percentFormatter.format(0);
    }

    return share < 0.005 ? '< 1 %' : percentFormatter.format(share);
}

/**
 * Format an amount as euros, e.g. 1234.5 => "1 234,50 €".
 * Rounding to 2 decimals happens here only, never in calculations.
 *
 * @param {number} amount
 * @returns {string}
 */
export function formatEuro(amount) {
    return euroFormatter.format(Number.isFinite(amount) ? amount : 0);
}
