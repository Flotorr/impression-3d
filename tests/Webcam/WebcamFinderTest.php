<?php

namespace App\Tests\Webcam;

use App\Webcam\WebcamFinder;
use PHPUnit\Framework\TestCase;
use Psr\Log\NullLogger;
use Symfony\Component\Cache\Adapter\ArrayAdapter;
use Symfony\Component\HttpClient\MockHttpClient;
use Symfony\Component\HttpClient\Response\JsonMockResponse;
use Symfony\Component\HttpClient\Response\MockResponse;

final class WebcamFinderTest extends TestCase
{
    private const BIARRITZ = [43.4806, -1.5568];

    private static function webcam(int $id, string $category, float $lat, float $lon, string $status = 'active'): array
    {
        return [
            'webcamId' => $id,
            'title' => "Cam $id",
            'status' => $status,
            'categories' => [['id' => $category, 'name' => $category]],
            'location' => ['latitude' => $lat, 'longitude' => $lon],
            'images' => ['current' => ['preview' => "https://img/$id/current.jpg"], 'daylight' => ['preview' => "https://img/$id/day.jpg"]],
            'player' => ['day' => "https://player/$id/day"],
            'urls' => ['detail' => "https://www.windy.com/webcams/$id", 'provider' => "https://provider.example/$id"],
        ];
    }

    public function testOnlyBeachCamerasAndSendsTheKeyAsAHeader(): void
    {
        $requests = [];
        $client = new MockHttpClient(function (string $method, string $url, array $options) use (&$requests) {
            $requests[] = [$url, $options];

            return new JsonMockResponse(['webcams' => [
                self::webcam(1, 'city', 43.481, -1.557),        // next door, but a street camera
                self::webcam(2, 'beach', 43.49, -1.56),         // a beach, a little further
                self::webcam(4, 'coast', 43.55, -1.6),          // coast too, but further still
                self::webcam(3, 'beach', 43.4807, -1.5569, 'inactive'),
            ]]);
        });
        $finder = new WebcamFinder($client, new ArrayAdapter(), new NullLogger(), 'secret-key');

        $webcam = $finder->nearest(...self::BIARRITZ);

        $this->assertNotNull($webcam);
        $this->assertSame('Cam 2', $webcam->title);
        $this->assertSame('https://img/2/day.jpg', $webcam->imageUrl, 'daylight image first');
        $this->assertSame('https://www.windy.com/webcams/2', $webcam->pageUrl);
        $this->assertSame('https://player/2/day', $webcam->playerUrl, 'timelapse of the day');
        $this->assertSame('https://provider.example/2', $webcam->providerUrl, 'where the live stream is');
        $this->assertGreaterThan(0, $webcam->distanceKm);

        [$url, $options] = $requests[0];
        $this->assertStringStartsWith('https://api.windy.com/webcams/api/v3/webcams', $url);
        $this->assertStringContainsString('nearby=43.480600%2C-1.556800%2C15', $url);
        $this->assertContains('x-windy-api-key: secret-key', $options['headers']);
        $this->assertStringNotContainsString('secret-key', $url, 'the key never goes into the URL');
    }

    public function testAnswersAreCached(): void
    {
        $calls = 0;
        $client = new MockHttpClient(function () use (&$calls) {
            ++$calls;

            return new JsonMockResponse(['webcams' => [self::webcam(2, 'beach', 43.49, -1.56)]]);
        });
        $finder = new WebcamFinder($client, new ArrayAdapter(), new NullLogger(), 'k');

        $finder->nearest(...self::BIARRITZ);
        $finder->nearest(...self::BIARRITZ);

        $this->assertSame(1, $calls);
    }

    public function testNothingWithoutKeyOrOnError(): void
    {
        $neverCalled = new MockHttpClient(fn () => throw new \LogicException('no request without a key'));
        $this->assertNull((new WebcamFinder($neverCalled, new ArrayAdapter(), new NullLogger(), ''))->nearest(...self::BIARRITZ));

        $failing = new MockHttpClient(new MockResponse('', ['http_code' => 500]));
        $this->assertNull((new WebcamFinder($failing, new ArrayAdapter(), new NullLogger(), 'k'))->nearest(...self::BIARRITZ));

        $streetsOnly = new MockHttpClient(new JsonMockResponse(['webcams' => [self::webcam(1, 'city', 43.481, -1.557)]]));
        $this->assertNull((new WebcamFinder($streetsOnly, new ArrayAdapter(), new NullLogger(), 'k'))->nearest(...self::BIARRITZ), 'no beach camera: nothing');

        $empty = new MockHttpClient(new JsonMockResponse(['webcams' => []]));
        $this->assertNull((new WebcamFinder($empty, new ArrayAdapter(), new NullLogger(), 'k'))->nearest(...self::BIARRITZ));
    }

    public function testDistance(): void
    {
        // Biarritz to Bayonne: about 6 km
        $this->assertEqualsWithDelta(6.3, WebcamFinder::distanceKm(43.4806, -1.5568, 43.4929, -1.4748), 0.5);
    }
}
