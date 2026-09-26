import { Controller } from '@hotwired/stimulus';
import { calculateCost } from '../lib/cost-calculator.js';
import { formatEuro, formatPercent } from '../lib/number-format.js';
import { donutSegments } from '../lib/donut.js';
import { errorMessage } from '../lib/messages.js';
import { parseShareParams, serializeParams } from '../lib/share-params.js';

// Reads the form, delegates all maths to lib/cost-calculator.js, renders the result.
// Connected on the .calculator wrapper (form + result panel).
export default class extends Controller {
    static targets = [
        'form', 'incomplete',
        'total', 'margin', 'price', 'microRow', 'contributions', 'invoice',
        'empty', 'breakdown', 'line', 'segment',
        'copyButton', 'copyStatus',
    ];

    connect() {
        this.restoreFromUrl();
        this.refresh();
        this.copyButtonTarget.hidden = false; // useless without JS, so hidden in the HTML
    }

    disconnect() {
        clearTimeout(this.copyTimer);
    }

    // Enter key in a field must not reload the page.
    preventSubmit(event) {
        event.preventDefault();
    }

    // Fill average power and printer price from the selected preset.
    // A preset value that is missing (null in config) leaves the field untouched.
    applyPreset(event) {
        const option = event.target.selectedOptions[0];
        const { power, price } = option?.dataset ?? {};
        if (power !== undefined) {
            this.setField('powerW', power);
        }
        if (price !== undefined) {
            this.setField('printerPriceEur', price);
        }
        if (event.target.value) {
            this.trackEvent('imprimante', { modele: event.target.value });
        }
    }

    // User changed something: recalculate and keep the address bar shareable.
    update() {
        this.refresh();
        this.syncUrl();
        // Counted once per visit: "used the calculator", not every keystroke.
        if (!this.calculationTracked) {
            this.calculationTracked = true;
            this.trackEvent('calcul');
        }
    }

    refresh() {
        const result = calculateCost(this.readParams());
        this.showErrors(result.errors);
        this.incompleteTarget.hidden = !result.hasErrors;
        this.render(result);
    }

    // Apply parameters found in the query string (shared link) over the server defaults.
    restoreFromUrl() {
        const shared = parseShareParams(window.location.search);
        for (const [name, value] of Object.entries(shared)) {
            if (name === 'mode') {
                const radio = this.formTarget.querySelector(`input[name="mode"][value="${value}"]`);
                if (radio) {
                    radio.checked = true;
                }
            } else if (name === 'microEnabled') {
                // Absent when the advanced mode is switched off: ignore such shared values.
                const checkbox = this.formTarget.elements.microEnabled;
                if (checkbox) {
                    checkbox.checked = value;
                }
            } else if (name === 'printer') {
                // Only select the model: power and price come from the link itself.
                const select = this.formTarget.elements.printer;
                if (select && [...select.options].some((option) => option.value === value)) {
                    select.value = value;
                }
            } else {
                this.setField(name, value);
            }
        }
    }

    // replaceState: adjusting a value must not fill the back button history.
    syncUrl() {
        window.history.replaceState(null, '', this.shareUrl());
    }

    shareUrl() {
        const url = new URL(window.location.href);
        url.search = serializeParams(this.readParams());
        url.hash = '';

        return url.toString();
    }

    async copyLink() {
        const url = this.shareUrl();
        this.syncUrl();
        let copied = false;
        try {
            await navigator.clipboard.writeText(url);
            copied = true;
        } catch {
            copied = this.copyWithSelection(url);
        }
        this.announceCopy(copied ? 'Lien copié dans le presse-papiers.' : 'Copie impossible : copiez le lien depuis la barre d\'adresse.');
        this.trackEvent('lien-partage');
    }

    // Umami custom event. No-op when the analytics script is absent (dev, tests, blocked by the visitor).
    trackEvent(name, data) {
        window.umami?.track(name, data);
    }

    // Fallback for browsers or contexts without the async Clipboard API.
    copyWithSelection(text) {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        try {
            return document.execCommand('copy');
        } catch {
            return false;
        } finally {
            field.remove();
        }
    }

    announceCopy(message) {
        this.copyStatusTarget.textContent = message;
        this.copyButtonTarget.classList.add('is-done');
        clearTimeout(this.copyTimer);
        this.copyTimer = setTimeout(() => {
            this.copyStatusTarget.textContent = '';
            this.copyButtonTarget.classList.remove('is-done');
        }, 2500);
    }

    readParams() {
        const params = {};
        for (const element of this.formTarget.elements) {
            if (!element.name) {
                continue;
            }
            if (element.type === 'checkbox') {
                params[element.name] = element.checked;
            } else if (element.type === 'radio') {
                if (element.checked) {
                    params[element.name] = element.value;
                }
            } else {
                params[element.name] = element.value;
            }
        }

        return params;
    }

    setField(name, value) {
        const input = this.formTarget.elements[name];
        if (input) {
            input.value = String(value).replace('.', ',');
        }
    }

    showErrors(errors) {
        const byField = new Map(errors.map((error) => [error.field, error]));
        for (const box of this.formTarget.querySelectorAll('[data-error-for]')) {
            const error = byField.get(box.dataset.errorFor);
            box.textContent = error ? errorMessage(error) : '';
            box.hidden = !error;
            this.formTarget.elements[box.dataset.errorFor]?.setAttribute('aria-invalid', error ? 'true' : 'false');
        }
    }

    render(result) {
        // `total` and `price` also appear in the compact bar shown on small screens.
        const total = formatEuro(result.total);
        const price = formatEuro(result.suggestedPrice);
        this.totalTargets.forEach((element) => { element.textContent = total; });
        this.priceTargets.forEach((element) => { element.textContent = price; });
        this.marginTarget.textContent = formatEuro(result.marginAmount);

        for (const row of this.microRowTargets) {
            row.hidden = result.micro === null;
        }
        if (result.micro) {
            this.contributionsTarget.textContent = formatEuro(result.micro.contributions);
            this.invoiceTarget.textContent = formatEuro(result.micro.invoicePrice);
        }

        this.renderBreakdown(result.lines);
    }

    // Legend rows and donut arcs, one per cost line with a positive amount.
    renderBreakdown(lines) {
        const segments = new Map(donutSegments(lines).map((segment) => [segment.key, segment]));
        const amounts = new Map(lines.map((line) => [line.key, line.amount]));

        this.emptyTarget.hidden = segments.size > 0;
        const wasHidden = this.breakdownTarget.hidden;
        this.breakdownTarget.hidden = segments.size === 0;
        if (wasHidden && segments.size > 0) {
            // Force a layout so the arcs animate from empty when the ring first appears.
            void this.breakdownTarget.offsetWidth;
        }

        for (const row of this.lineTargets) {
            const segment = segments.get(row.dataset.key);
            row.hidden = !segment;
            if (segment) {
                row.querySelector('[data-role="amount"]').textContent = formatEuro(amounts.get(row.dataset.key));
                row.querySelector('[data-role="share"]').textContent = formatPercent(segment.share);
            }
        }

        for (const circle of this.segmentTargets) {
            const segment = segments.get(circle.dataset.key);
            circle.setAttribute('stroke-dasharray', segment ? `${segment.dash} ${segment.gap}` : '0 100');
            circle.setAttribute('stroke-dashoffset', segment ? segment.offset : 25);
        }
    }
}
