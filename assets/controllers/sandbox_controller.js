/* stimulusFetch: 'lazy' */
import { Controller } from '@hotwired/stimulus';
import { SandScene } from '../lib/sand-scene.js';
import { compass, OBJECT_TYPES, OCEAN, parseMarine, SIDES, toolForKey, TOOLS } from '../lib/sand-physics.js';

// Open-Meteo (https://open-meteo.com): free for non-commercial use, no key, CC BY 4.0 attribution shown on the card.
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const MARINE_FIELDS = 'wave_height,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature';

const BRUSH_COLOURS = {
    dig: '#e0763c', raise: '#f2c14e', clay: '#c4623d', rock: '#8d9299', push: '#ffffff',
    water: '#3fa7d6', lava: '#ff7a1a', objects: '#ffffff', spring: '#3fa7d6', sponge: '#a5ecff', hammer: '#ffffff',
};
const numberFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SIZE = { min: 0.03, max: 0.2 }; // brush radius in uv units

/**
 * Sandbox page: builds the tool bar, drives the 3D scene, handles keyboard shortcuts and the PNG capture.
 */
export default class extends Controller {
    static targets = [
        'viewport', 'tools', 'size', 'strength', 'waterSpeed', 'waterSpeedOutput', 'rain', 'erosion', 'springs', 'repair',
        'objectType', 'clearObjects', 'city', 'oceanCard', 'oceanPlace', 'oceanFacts', 'oceanSubmit', 'toast', 'panelToggle', 'fallback',
    ];

    connect() {
        this.renderTools();
        this.renderObjectTypes();
        try {
            this.scene = new SandScene(this.viewportTarget, {
                reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
            });
        } catch {
            this.fallbackTarget.hidden = false;
            this.element.classList.add('is-fallback');

            return;
        }
        this.scene.onSpringsChange = (springs) => this.updateSprings(springs);
        this.scene.onPanesChange = (broken) => this.panesChanged(broken);
        this.scene.onObjectsChange = (count) => this.objectsChanged(count);
        this.scene.objectType = this.objectTypeTarget.value;
        this.objectsChanged(0);
        this.selectTool('dig', { silent: true });
        this.setSize();
        this.setStrength();
        this.setWaterSpeed();
        // The browser may restore checkboxes (back/forward cache, reload): follow what is shown.
        this.scene.setRain(this.rainTarget.checked);
        this.element.classList.toggle('is-raining', this.rainTarget.checked);
        this.toggleErosion();
        this.updateSprings([]);
        this.repairTarget.disabled = true;

        this.scene.setRunning(true);
        this.observer = new IntersectionObserver(([entry]) => this.scene.setRunning(entry.isIntersecting));
        this.observer.observe(this.viewportTarget);
        this.onKeyDown = (event) => this.shortcut(event);
        addEventListener('keydown', this.onKeyDown);
        this.element.classList.add('is-ready');
    }

    disconnect() {
        clearInterval(this.oceanTimer);
        removeEventListener('keydown', this.onKeyDown);
        this.observer?.disconnect();
        this.scene?.dispose();
        clearTimeout(this.toastTimer);
    }

    // --- Actions -------------------------------------------------------------

    pickTool(event) {
        this.selectTool(event.currentTarget.dataset.tool);
    }

    setSize() {
        const t = Number(this.sizeTarget.value) / 100;
        this.scene.brushRadius = SIZE.min + t * (SIZE.max - SIZE.min);
    }

    setStrength() {
        this.scene.strength = Number(this.strengthTarget.value) / 100;
    }

    setWaterSpeed() {
        const speed = Number(this.waterSpeedTarget.value) / 100;
        this.scene.sim.waterSpeed = speed;
        this.waterSpeedOutputTarget.value = `×${numberFormat.format(speed)}`;
    }

    toggleRain() {
        this.scene.setRain(this.rainTarget.checked);
        this.element.classList.toggle('is-raining', this.rainTarget.checked);
        if (this.rainTarget.checked) {
            this.track('pluie');
        }
    }

    toggleErosion() {
        this.scene.sim.erosion = this.erosionTarget.checked;
    }

    newDunes() {
        this.scene.sim.reset();
        this.toast('Nouvelles dunes.');
        this.track('nouvelles-dunes');
    }

    // --- Live ocean ----------------------------------------------------------------

    async loadOcean(event) {
        event.preventDefault();
        const name = this.cityTarget.value.trim();
        if (!name) {
            return;
        }
        this.oceanSubmitTarget.disabled = true;
        try {
            const geo = await this.getJson(`${GEOCODING}?${new URLSearchParams({ name, count: 1, language: 'fr' })}`);
            const place = geo.results?.[0];
            if (!place) {
                this.toast(`Ville introuvable : ${name}.`);
                return;
            }
            const swell = await this.fetchSwell(place);
            if (!swell) {
                this.toast(`Pas de mer assez proche de ${place.name} pour mesurer la houle.`);
                return;
            }
            this.place = place;
            this.scene.startOcean(swell);
            this.renderOcean(swell);
            clearInterval(this.oceanTimer);
            this.oceanTimer = setInterval(() => this.refreshOcean(), OCEAN.refreshMinutes * 60 * 1000);
            this.track('ocean', { ville: place.name });
        } catch {
            this.toast('Les données de houle sont injoignables pour le moment.');
        } finally {
            this.oceanSubmitTarget.disabled = false;
        }
    }

    stopOcean() {
        clearInterval(this.oceanTimer);
        this.scene.stopOcean();
        this.oceanCardTarget.hidden = true;
        this.place = null;
    }

    async refreshOcean() {
        if (!this.place) {
            return;
        }
        try {
            const swell = await this.fetchSwell(this.place);
            if (swell) {
                this.scene.updateOcean(swell);
                this.renderOcean(swell);
            }
        } catch {
            // Keep the last reading; the next refresh will try again.
        }
    }

    async fetchSwell({ latitude, longitude, timezone }) {
        const query = new URLSearchParams({ latitude, longitude, current: MARINE_FIELDS, timezone: timezone ?? 'auto' });

        return parseMarine(await this.getJson(`${MARINE}?${query}`));
    }

    async getJson(url) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return response.json();
    }

    renderOcean(swell) {
        const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
        this.oceanPlaceTarget.textContent = [this.place.name, this.place.admin1, this.place.country].filter(Boolean).join(', ');
        const time = swell.time ? swell.time.slice(11, 16) : '';
        const rows = [
            ['Houle', `${decimal.format(swell.height)} m`],
            ['Période', `${decimal.format(swell.period)} s`],
            ['Vient du', swell.direction === null ? '–' : `${compass(swell.direction)} (${Math.round(swell.direction)}°)`],
            ['Mer totale', swell.waves === null ? '–' : `${decimal.format(swell.waves)} m`],
            ['Eau', swell.temperature === null ? '–' : `${decimal.format(swell.temperature)} °C`],
            ['Relevé', time ? `${time} (heure locale)` : '–'],
        ];
        this.oceanFactsTarget.replaceChildren(...rows.flatMap(([term, value]) => {
            const dt = document.createElement('dt');
            dt.textContent = term;
            const dd = document.createElement('dd');
            dd.textContent = value;

            return [dt, dd];
        }));
        this.oceanCardTarget.hidden = false;
    }

    clearSand() {
        this.scene.sim.clearSand();
        this.toast('Sable retiré.');
    }

    clearLava() {
        this.scene.sim.clearLava();
        this.toast('Lave retirée.');
    }

    emptyTank() {
        this.scene.sim.clearAll();
        this.toast('Le bac est vide.');
        this.track('bac-vide');
    }

    fillWater() {
        this.scene.sim.fill();
        this.toast("Bac rempli d'eau.");
        this.track('remplir');
    }

    drain() {
        this.scene.sim.drain();
        this.toast("L'eau a été vidée.");
    }

    setObjectType() {
        this.scene.objectType = this.objectTypeTarget.value;
        this.selectTool('objects');
    }

    clearObjects() {
        this.scene.clearObjects();
    }

    repairPanes() {
        this.scene.repairPanes();
        this.toast('Vitres réparées.');
    }

    clearSprings() {
        this.scene.setSprings([]);
        this.updateSprings([]);
    }

    async download() {
        const link = document.createElement('a');
        link.href = this.scene.capture();
        link.download = 'bac-a-sable-flotor.png';
        link.click();
        this.track('capture-png');
    }

    togglePanel() {
        const open = !this.element.classList.contains('is-panel-open');
        this.element.classList.toggle('is-panel-open', open);
        this.panelToggleTarget.setAttribute('aria-expanded', String(open));
    }

    // --- Rendering -------------------------------------------------------------

    renderTools() {
        this.toolButtons = TOOLS.map((tool) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `tool tool-${tool.id}`;
            button.dataset.tool = tool.id;
            button.dataset.action = 'sandbox#pickTool';
            button.setAttribute('aria-pressed', 'false');
            button.title = `${tool.hint} (touche ${tool.key})`;
            const label = document.createElement('span');
            label.textContent = tool.label;
            const key = document.createElement('kbd');
            key.textContent = tool.key;
            button.append(label, key);

            return button;
        });
        this.toolsTarget.replaceChildren(...this.toolButtons);
    }

    selectTool(id, { silent = false } = {}) {
        this.scene.setTool(id);
        this.scene.setBrushColour(BRUSH_COLOURS[id]);
        for (const button of this.toolButtons) {
            button.setAttribute('aria-pressed', String(button.dataset.tool === id));
        }
        this.element.dataset.tool = id;
        if (!silent) {
            this.track('outil', { nom: id });
        }
    }

    renderObjectTypes() {
        this.objectTypeTarget.replaceChildren(...OBJECT_TYPES.map(({ id, label }) => new Option(label, id)));
    }

    objectsChanged(count) {
        this.clearObjectsTarget.disabled = count === 0;
        this.clearObjectsTarget.textContent = count === 0 ? 'Aucun objet' : `Retirer les objets (${count})`;
        if (count > 0 && !this.placedObject) {
            this.placedObject = true;
            this.track('objet', { type: this.objectTypeTarget.value });
        }
    }

    panesChanged(broken) {
        const count = broken.filter(Boolean).length;
        this.repairTarget.disabled = count === 0;
        this.repairTarget.textContent = count === 0 ? 'Vitres intactes' : `Réparer les vitres (${count})`;
        const last = this.lastBroken ?? [];
        const side = broken.findIndex((b, i) => b && !last[i]);
        if (side !== -1) {
            this.toast(`Crac ! La vitre ${SIDES[side].label} a cédé.`);
            this.track('vitre-cassee', { cote: SIDES[side].id });
        }
        this.lastBroken = [...broken];
    }

    updateSprings(springs) {
        this.springsTarget.disabled = springs.length === 0;
        this.springsTarget.textContent = springs.length === 0 ? 'Aucune source' : `Retirer les sources (${springs.length})`;
    }

    toast(message) {
        this.toastTarget.textContent = message;
        this.toastTarget.classList.add('is-visible');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => this.toastTarget.classList.remove('is-visible'), 2200);
    }

    shortcut(event) {
        const typing = event.target instanceof Element && event.target.closest('input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable]');
        if (event.ctrlKey || event.metaKey || event.altKey || typing) {
            return;
        }
        const tool = toolForKey(event.key.toLowerCase());
        if (tool) {
            this.selectTool(tool.id);
        } else if (event.key === '[' || event.key === ']') {
            const step = event.key === ']' ? 10 : -10;
            this.sizeTarget.value = String(Math.min(100, Math.max(0, Number(this.sizeTarget.value) + step)));
            this.setSize();
        }
    }

    track(name, data) {
        // Umami custom event. No-op when the analytics script is absent (dev, tests, blocked by the visitor).
        window.umami?.track(name, data);
    }
}
