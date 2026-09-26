// French user-facing messages for the error codes returned by cost-calculator.js.
// Pure: no DOM. Messages are shown right under the offending field.

const BY_CODE = {
    invalid: 'Saisissez un nombre, par exemple 12,5.',
    negative: 'La valeur ne peut pas être négative.',
    must_be_positive: 'La valeur doit être supérieure à 0.',
    too_high: 'La valeur doit être inférieure à 100 %.',
};

// More specific wording where the generic message would not explain why.
const BY_FIELD_AND_CODE = {
    'spoolWeightG:must_be_positive': 'Le poids de la bobine doit être supérieur à 0 pour calculer le coût du filament.',
    'lifespanH:must_be_positive': "La durée de vie doit être supérieure à 0 pour calculer l'usure de la machine.",
    'microRatePct:too_high': 'Le taux de cotisations doit être inférieur à 100 %.',
};

/**
 * @param {{field: string, code: string}} error
 * @returns {string}
 */
export function errorMessage({ field, code }) {
    return BY_FIELD_AND_CODE[`${field}:${code}`] ?? BY_CODE[code] ?? 'Valeur invalide.';
}
