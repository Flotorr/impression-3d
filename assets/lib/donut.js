// Geometry for a donut chart drawn with SVG circle strokes. Pure: no DOM.
//
// The ring is a <circle r="15.9155"> whose circumference is 100 user units, so a
// segment's stroke-dasharray is expressed directly in percent of the ring.

export const DONUT_RADIUS = 100 / (2 * Math.PI); // circumference = 100

/**
 * @param {{key: string, amount: number}[]} lines
 * @returns {{key: string, share: number, dash: number, gap: number, offset: number}[]}
 *   One entry per line with a positive amount, in input order, starting at 12 o'clock
 *   and going clockwise. `share` is 0..1; use dash/gap/offset as
 *   stroke-dasharray="dash gap" and stroke-dashoffset="offset".
 */
export function donutSegments(lines) {
    const positive = lines.filter((line) => Number.isFinite(line.amount) && line.amount > 0);
    const total = positive.reduce((sum, line) => sum + line.amount, 0);
    if (total <= 0) {
        return [];
    }

    let start = 0; // percent of the ring already used
    return positive.map((line) => {
        const share = line.amount / total;
        const dash = share * 100;
        const segment = {
            key: line.key,
            share,
            dash,
            gap: 100 - dash,
            // An offset of 25 moves the start of the dash pattern to 12 o'clock.
            offset: 25 - start,
        };
        start += dash;

        return segment;
    });
}
