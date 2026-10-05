<?php

namespace App\Webcam;

use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;
use Symfony\Contracts\HttpClient\Exception\ExceptionInterface;
use Symfony\Contracts\HttpClient\HttpClientInterface;

/**
 * Finds the beach or coast webcam closest to a place with the Windy Webcams API (https://api.windy.com/webcams);
 * street or road cameras are ignored. The key stays on the server. Image links expire after 10 minutes on the free tier,
 * so answers are cached for less than that.
 */
final class WebcamFinder
{
    private const ENDPOINT = 'https://api.windy.com/webcams/api/v3/webcams';
    private const RADIUS_KM = 15;
    private const CACHE_SECONDS = 480;
    private const SEASIDE = ['beach', 'coast'];

    public function __construct(
        private readonly HttpClientInterface $httpClient,
        private readonly CacheInterface $cache,
        private readonly LoggerInterface $logger,
        #[Autowire('%env(WINDY_WEBCAMS_KEY)%')]
        private readonly string $apiKey,
    ) {
    }

    public function isConfigured(): bool
    {
        return '' !== $this->apiKey;
    }

    public function nearest(float $lat, float $lon): ?Webcam
    {
        if (!$this->isConfigured()) {
            return null;
        }
        // About 1 km of rounding: neighbours share one cached answer.
        $key = sprintf('webcam_v2_%.2f_%.2f', $lat, $lon); // bump the version when Webcam changes shape

        return $this->cache->get($key, function (ItemInterface $item) use ($lat, $lon): ?Webcam {
            $item->expiresAfter(self::CACHE_SECONDS);

            return $this->fetch($lat, $lon);
        });
    }

    private function fetch(float $lat, float $lon): ?Webcam
    {
        try {
            $data = $this->httpClient->request('GET', self::ENDPOINT, [
                'headers' => ['x-windy-api-key' => $this->apiKey],
                'query' => [
                    'nearby' => sprintf('%F,%F,%d', $lat, $lon, self::RADIUS_KM),
                    'include' => 'categories,images,location,player,urls',
                    'limit' => 20,
                    'lang' => 'fr',
                ],
                'timeout' => 5,
            ])->toArray();
        } catch (ExceptionInterface $e) {
            $this->logger->warning('Windy webcams request failed: {message}', ['message' => $e->getMessage()]);

            return null;
        }

        $best = null;
        $bestScore = INF; // distance in km
        foreach ($data['webcams'] ?? [] as $webcam) {
            $image = $webcam['images']['daylight']['preview'] ?? $webcam['images']['current']['preview'] ?? null;
            $page = $webcam['urls']['detail'] ?? null;
            $latitude = $webcam['location']['latitude'] ?? null;
            $longitude = $webcam['location']['longitude'] ?? null;
            if (null === $image || null === $page || null === $latitude || null === $longitude
                || ($webcam['status'] ?? 'active') !== 'active') {
                continue;
            }
            $distance = self::distanceKm($lat, $lon, (float) $latitude, (float) $longitude);
            $categories = array_column($webcam['categories'] ?? [], 'id');
            if ([] === array_intersect($categories, self::SEASIDE)) {
                continue; // a motorway or a town square says nothing about the waves
            }
            if ($distance < $bestScore) {
                $bestScore = $distance;
                $best = new Webcam(
                    (string) ($webcam['title'] ?? 'Webcam'),
                    (string) $image,
                    (string) $page,
                    isset($webcam['player']['day']) ? (string) $webcam['player']['day'] : null,
                    isset($webcam['urls']['provider']) ? (string) $webcam['urls']['provider'] : null,
                    round($distance, 1),
                );
            }
        }

        return $best;
    }

    /** Great-circle distance (haversine). */
    public static function distanceKm(float $lat1, float $lon1, float $lat2, float $lon2): float
    {
        $toRad = M_PI / 180;
        $a = sin(($lat2 - $lat1) * $toRad / 2) ** 2
            + cos($lat1 * $toRad) * cos($lat2 * $toRad) * sin(($lon2 - $lon1) * $toRad / 2) ** 2;

        return 6371 * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }
}
