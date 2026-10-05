import { parseMarine } from './sand-physics.js';

// Open-Meteo (https://open-meteo.com): free for non-commercial use, no key, CC BY 4.0 attribution shown on the page.
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const MARINE_FIELDS = 'wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature';

async function getJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
}

/** The best match for a town name, or null. */
export async function findPlace(name) {
    const geo = await getJson(`${GEOCODING}?${new URLSearchParams({ name, count: 1, language: 'fr' })}`);

    return geo.results?.[0] ?? null;
}

/** The swell at a place right now (see parseMarine), or null when there is no sea close enough. */
export async function fetchSwell({ latitude, longitude, timezone }) {
    const query = new URLSearchParams({ latitude, longitude, current: MARINE_FIELDS, timezone: timezone ?? 'auto' });

    return parseMarine(await getJson(`${MARINE}?${query}`));
}

export function placeLabel(place) {
    return [place.name, place.admin1, place.country].filter(Boolean).join(', ');
}
