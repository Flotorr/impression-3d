/* stimulusFetch: 'lazy' */
import { Controller } from '@hotwired/stimulus';
import { fetchSwell, findPlace, placeLabel } from '../lib/ocean-data.js';
import { SandScene } from '../lib/sand-scene.js';
import { compass, OCEAN } from '../lib/sand-physics.js';

const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const WEBCAM_REFRESH_MINUTES = 8; // Windy's free image links expire after 10 minutes

/**
 * Wave tank page (/houle): a beach whose swell is the real one of a coastal town (Open-Meteo), with a surfer for scale.
 * The town is in the URL (?ville=…) so a link opens on the same beach.
 */
export default class extends Controller {
    static targets = [
        'viewport', 'city', 'submit', 'place', 'facts', 'card', 'status', 'panelToggle', 'fallback',
        'webcam', 'webcamLink', 'webcamImage', 'webcamTitle', 'webcamPlayer', 'webcamPlay', 'webcamLive', 'webcamLiveNote',
        'webcamDialog', 'webcamDialogTitle', 'webcamDialogLive',
    ];
    static values = { defaultCity: String, webcamUrl: String, spots: Array };

    connect() {
        try {
            this.scene = new SandScene(this.viewportTarget, {
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
                tools: false,
            });
        } catch {
            this.fallbackTarget.hidden = false;
            this.element.classList.add('is-fallback');

            return;
        }
        this.scene.setRunning(true);
        this.observer = new IntersectionObserver(([entry]) => this.scene.setRunning(entry.isIntersecting));
        this.observer.observe(this.viewportTarget);
        this.element.classList.add('is-ready');

        const city = new URLSearchParams(location.search).get('ville') || this.defaultCityValue;
        this.cityTarget.value = city;
        this.load(city, { initial: true });
    }

    disconnect() {
        clearInterval(this.timer);
        clearInterval(this.webcamTimer);
        this.observer?.disconnect();
        this.scene?.dispose();
    }

    submit(event) {
        event.preventDefault();
        const city = this.cityTarget.value.trim();
        if (city) {
            this.load(city);
        }
    }

    pick(event) {
        this.cityTarget.value = event.currentTarget.dataset.city;
        this.load(event.currentTarget.dataset.city);
    }

    /** A known spot has the exact coordinates of its beach; any other name goes through the town search. */
    async resolve(city) {
        const spot = this.spotsValue.find(({ name }) => name.localeCompare(city, 'fr', { sensitivity: 'base' }) === 0);

        return spot ? { ...spot, timezone: 'auto' } : findPlace(city);
    }

    togglePanel() {
        const open = !this.element.classList.contains('is-panel-open');
        this.element.classList.toggle('is-panel-open', open);
        this.panelToggleTarget.setAttribute('aria-expanded', String(open));
    }

    async load(city, { initial = false } = {}) {
        this.submitTarget.disabled = true;
        this.status('Recherche de la houle…');
        try {
            const place = await this.resolve(city);
            if (!place) {
                this.status(`Ville introuvable : ${city}.`);
                return;
            }
            const swell = await fetchSwell(place);
            if (!swell) {
                this.status(`Pas de mer assez proche de ${place.name} pour mesurer la houle.`);
                return;
            }
            this.place = place;
            this.scene.startOcean(swell);
            this.render(swell);
            this.status('');
            history.replaceState(null, '', `${location.pathname}?${new URLSearchParams({ ville: place.name })}`);
            clearInterval(this.timer);
            this.timer = setInterval(() => this.refresh(), OCEAN.refreshMinutes * 60 * 1000);
            this.loadWebcam();
            clearInterval(this.webcamTimer);
            this.webcamTimer = setInterval(() => this.loadWebcam(), WEBCAM_REFRESH_MINUTES * 60 * 1000);
            if (!initial) {
                this.track('ocean', { ville: place.name });
            }
        } catch {
            this.status('Les données de houle sont injoignables pour le moment.');
        } finally {
            this.submitTarget.disabled = false;
        }
    }

    async refresh() {
        try {
            const swell = await fetchSwell(this.place);
            if (swell) {
                this.scene.updateOcean(swell);
                this.render(swell);
            }
        } catch {
            // Keep the last reading; the next refresh will try again.
        }
    }

    /** The beach webcam nearest to the town, if the server has a Windy key and finds one. */
    async loadWebcam() {
        const place = this.place;
        try {
            const query = new URLSearchParams({ lat: place.latitude, lon: place.longitude });
            const response = await fetch(`${this.webcamUrlValue}?${query}`);
            const webcam = response.ok ? await response.json() : { available: false };
            if (place !== this.place) {
                return; // another town was picked meanwhile
            }
            if (!webcam.available) {
                this.webcamTarget.hidden = true;
                return;
            }
            const changed = this.webcam?.pageUrl !== webcam.pageUrl;
            this.webcam = webcam;
            this.webcamImageTarget.src = webcam.imageUrl;
            this.webcamImageTarget.alt = `Webcam : ${webcam.title}`;
            this.webcamLinkTarget.href = webcam.pageUrl;
            this.webcamTitleTarget.textContent = `${webcam.title} (à ${decimal.format(webcam.distanceKm)} km)`;
            // The live stream belongs to the camera's operator: a link to their page, never embedded.
            this.webcamLiveTarget.hidden = !webcam.providerUrl;
            if (webcam.providerUrl) {
                this.webcamLiveTarget.href = webcam.providerUrl;
                this.webcamLiveNoteTarget.textContent = `· direct sur ${new URL(webcam.providerUrl).hostname.replace(/^www\./, '')}`;
            }
            this.webcamLiveNoteTarget.hidden = !webcam.providerUrl;
            this.webcamPlayTarget.hidden = !webcam.playerUrl;
            if (changed && this.webcamDialogTarget.open) {
                this.webcamDialogTarget.close();
            }
            this.webcamTarget.hidden = false;
        } catch {
            this.webcamTarget.hidden = true;
        }
    }

    /** Windy's player, large, over the page: the images of the day, up to the latest one. */
    playTimelapse() {
        if (!this.webcam?.playerUrl) {
            return;
        }
        this.webcamDialogTitleTarget.textContent = this.webcam.title;
        this.webcamDialogLiveTarget.hidden = !this.webcam.providerUrl;
        if (this.webcam.providerUrl) {
            this.webcamDialogLiveTarget.href = this.webcam.providerUrl;
        }
        this.webcamPlayerTarget.src = this.webcam.playerUrl;
        this.webcamDialogTarget.showModal();
        this.track('timelapse');
    }

    closeTimelapse() {
        if (this.webcamDialogTarget.open) {
            this.webcamDialogTarget.close();
        }
        this.webcamPlayerTarget.removeAttribute('src'); // stops the player
    }

    // A click on the dimmed backdrop (outside the box) closes the dialog.
    clickOutside(event) {
        if (event.target === this.webcamDialogTarget) {
            this.closeTimelapse();
        }
    }

    render(swell) {
        this.placeTarget.textContent = placeLabel(this.place);
        const time = swell.time ? swell.time.slice(11, 16) : '';
        const rows = [
            ['Houle', `${decimal.format(swell.height)} m`],
            ['Période', `${decimal.format(swell.period)} s`],
            ['Vient du', swell.direction === null ? '–' : `${compass(swell.direction)} (${Math.round(swell.direction)}°)`],
            ['Mer totale', swell.waves === null ? '–' : `${decimal.format(swell.waves)} m`],
            ['Eau', swell.temperature === null ? '–' : `${decimal.format(swell.temperature)} °C`],
            ['Relevé', time ? `${time} (heure locale)` : '–'],
        ];
        this.factsTarget.replaceChildren(...rows.flatMap(([term, value]) => {
            const dt = document.createElement('dt');
            dt.textContent = term;
            const dd = document.createElement('dd');
            dd.textContent = value;

            return [dt, dd];
        }));
        this.cardTarget.hidden = false;
    }

    status(message) {
        this.statusTarget.textContent = message;
        this.statusTarget.hidden = message === '';
    }

    track(name, data) {
        // Umami custom event. No-op when the analytics script is absent (dev, tests, blocked by the visitor).
        window.umami?.track(name, data);
    }
}
