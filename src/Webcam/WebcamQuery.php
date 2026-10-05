<?php

namespace App\Webcam;

use Symfony\Component\Validator\Constraints as Assert;

/** Query string of /api/webcam: the place to look around, in decimal degrees. */
final readonly class WebcamQuery
{
    public function __construct(
        #[Assert\NotNull]
        #[Assert\Range(min: -90, max: 90)]
        public ?float $lat = null,
        #[Assert\NotNull]
        #[Assert\Range(min: -180, max: 180)]
        public ?float $lon = null,
    ) {
    }
}
