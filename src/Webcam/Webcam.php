<?php

namespace App\Webcam;

/**
 * A webcam to show next to the wave tank. URLs come from Windy and must be used as they are:
 * `playerUrl` is Windy's embeddable timelapse of the day, `providerUrl` the operator's page (often with the live stream).
 */
final readonly class Webcam
{
    public function __construct(
        public string $title,
        public string $imageUrl,
        public string $pageUrl,
        public ?string $playerUrl,
        public ?string $providerUrl,
        public float $distanceKm,
    ) {
    }
}
