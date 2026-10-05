<?php

namespace App\Tests\Controller;

use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Bundle\FrameworkBundle\Test\WebTestCase;

/**
 * Smoke tests for the sandbox page and SEO-critical markup.
 */
final class PagesTest extends WebTestCase
{
    public function testHomePageBasics(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/');

        $this->assertResponseIsSuccessful();
        $this->assertCount(1, $crawler->filter('h1'), 'exactly one H1');
        $this->assertSame('fr', $crawler->filter('html')->attr('lang'));
        $this->assertSelectorTextContains('h1', 'Bac à sable');

        $stage = $crawler->filter('[data-controller="sandbox"]');
        $this->assertCount(1, $stage);
        foreach (['viewport', 'tools', 'size', 'strength', 'waterSpeed', 'rain', 'erosion', 'springs', 'repair', 'fallback'] as $target) {
            $this->assertCount(1, $stage->filter(sprintf('[data-sandbox-target="%s"]', $target)), $target);
        }
        $this->assertNotNull($stage->filter('[data-sandbox-target="fallback"]')->attr('hidden'), 'fallback hidden until WebGL fails');
        $this->assertCount(1, $crawler->filter('#a-propos h2'), 'explanatory text for visitors and search engines');
    }

    public function testWaveTankPage(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/houle?ville=Hossegor');

        $this->assertResponseIsSuccessful();
        $this->assertCount(1, $crawler->filter('h1'), 'exactly one H1');
        $this->assertSelectorTextContains('h1', 'houle');
        $this->assertSame('https://flotor.fr/houle', $crawler->filter('link[rel="canonical"]')->attr('href'), 'the town is not part of the canonical URL');
        $stage = $crawler->filter('[data-controller="ocean"]');
        $this->assertCount(1, $stage);
        $this->assertSame('Biarritz', $stage->attr('data-ocean-default-city-value'));
        foreach (['viewport', 'city', 'card', 'facts', 'webcam', 'fallback'] as $target) {
            $this->assertCount(1, $stage->filter(sprintf('[data-ocean-target="%s"]', $target)), $target);
        }
        $this->assertGreaterThanOrEqual(3, $stage->filter('[data-action="ocean#pick"]')->count(), 'a few known spots');
        $this->assertStringContainsString('Open-Meteo', $stage->text(), 'CC BY attribution');
        // The sand tools stay on the sandbox page.
        $this->assertCount(0, $crawler->filter('[data-controller="sandbox"]'));

        $title = $crawler->filter('title')->text();
        $description = $crawler->filter('meta[name="description"]')->attr('content');
        $this->assertLessThanOrEqual(65, mb_strlen($title));
        $this->assertGreaterThanOrEqual(80, mb_strlen($description));
        $this->assertLessThanOrEqual(165, mb_strlen($description));
    }

    public function testWebcamEndpointWithoutKey(): void
    {
        $client = static::createClient();
        $client->request('GET', '/api/webcam?lat=43.48&lon=-1.56');

        $this->assertResponseIsSuccessful();
        $this->assertSame(['available' => false], json_decode($client->getResponse()->getContent(), true));

        $client->request('GET', '/api/webcam?lat=120&lon=-1.56');
        $this->assertResponseStatusCodeSame(422, 'latitude out of range');
        $client->request('GET', '/api/webcam');
        $this->assertResponseStatusCodeSame(422, 'missing coordinates');
    }

    public function testBothPagesOfferTheTankSwitch(): void
    {
        $client = static::createClient();
        foreach (['/' => 'Bac à sable', '/houle' => 'Bac à houle'] as $path => $current) {
            $crawler = $client->request('GET', $path);
            $switch = $crawler->filter('nav.mode-switch');
            $this->assertCount(1, $switch->filter('a[href="/"]'));
            $this->assertCount(1, $switch->filter('a[href="/houle"]'));
            $this->assertSame($current, $switch->filter('a[aria-current="page"]')->text());
        }
        // The ocean is not mixed into the sandbox any more.
        $this->assertCount(0, $client->request('GET', '/')->filter('[data-ocean-target]'));
    }

    public function testCanonicalIgnoresQueryString(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/?utm_source=test');

        $this->assertSame('https://flotor.fr/', $crawler->filter('link[rel="canonical"]')->attr('href'));
        $this->assertSame('https://flotor.fr/', $crawler->filter('meta[property="og:url"]')->attr('content'));
    }

    public function testMetaTags(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/');

        $title = $crawler->filter('title')->text();
        $description = $crawler->filter('meta[name="description"]')->attr('content');

        $this->assertLessThanOrEqual(65, mb_strlen($title), 'title should stay short enough for search results');
        $this->assertGreaterThanOrEqual(80, mb_strlen($description));
        $this->assertLessThanOrEqual(165, mb_strlen($description));
        $this->assertSame($title, $crawler->filter('meta[property="og:title"]')->attr('content'));
        $this->assertSame('https://flotor.fr/og-image.png', $crawler->filter('meta[property="og:image"]')->attr('content'));
        $this->assertFileExists(__DIR__.'/../../public/og-image.png');
    }

    public function testHomeHasWebApplicationData(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/');

        $scripts = $crawler->filter('script[type="application/ld+json"]');
        $this->assertCount(1, $scripts);
        $data = json_decode($scripts->text(null, false), true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame('WebApplication', $data['@type']);
        $this->assertSame('https://flotor.fr/', $data['url']);
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function legacyPaths(): iterable
    {
        yield 'calculator' => ['/calculateur-cout-impression-3d'];
        yield 'faq' => ['/faq-impression-3d'];
    }

    #[DataProvider('legacyPaths')]
    public function testFormerCalculatorPagesRedirectToHome(string $path): void
    {
        $client = static::createClient();
        $client->request('GET', $path);

        $this->assertResponseRedirects('/', 301);
    }

    public function testNoTracesOfFormerProjects(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/');

        $page = $crawler->filter('html')->html();
        foreach (['impression 3d', 'calculateur', 'planète'] as $word) {
            $this->assertStringNotContainsStringIgnoringCase($word, $page);
        }
    }

    public function testLegalPageFollowsItsFeatureSwitch(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/mentions-legales');

        if (!$this->feature('legal_page')) {
            $this->assertResponseStatusCodeSame(404);
            $home = $client->request('GET', '/');
            $this->assertCount(0, $home->filter('a[href="/mentions-legales"]'), 'no footer link while the page is off');

            return;
        }

        $this->assertResponseIsSuccessful();
        $this->assertCount(1, $crawler->filter('h1'));
        $this->assertGreaterThan(0, $crawler->filter('mark.todo')->count(), 'placeholders are marked');
        $this->assertSame('https://flotor.fr/mentions-legales', $crawler->filter('link[rel="canonical"]')->attr('href'));
    }

    public function testStaticSeoFilesListTheRealPages(): void
    {
        $sitemap = file_get_contents(__DIR__.'/../../public/sitemap.xml');
        $xml = simplexml_load_string($sitemap);
        $this->assertNotFalse($xml, 'sitemap is valid XML');
        $urls = [];
        foreach ($xml->url as $url) { // XML comments are ignored by the parser
            $urls[] = (string) $url->loc;
        }
        $expected = ['https://flotor.fr/', 'https://flotor.fr/houle'];
        if ($this->feature('legal_page')) {
            $expected[] = 'https://flotor.fr/mentions-legales';
        }
        $this->assertSame($expected, $urls);

        $robots = file_get_contents(__DIR__.'/../../public/robots.txt');
        $this->assertStringContainsString('Sitemap: https://flotor.fr/sitemap.xml', $robots);
    }

    public function testNoAnalyticsWithoutWebsiteId(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/');

        $this->assertCount(0, $crawler->filter('script[src*="umami"]'));
    }

    public function testAnalyticsScriptNeverSendsTheQueryString(): void
    {
        $_SERVER['UMAMI_WEBSITE_ID'] = $_ENV['UMAMI_WEBSITE_ID'] = 'test-website-id';
        try {
            $client = static::createClient();
            $crawler = $client->request('GET', '/?utm_source=test');
        } finally {
            $_SERVER['UMAMI_WEBSITE_ID'] = $_ENV['UMAMI_WEBSITE_ID'] = '';
        }

        $script = $crawler->filter('script[src="https://cloud.umami.is/script.js"]');
        $this->assertCount(1, $script);
        $this->assertSame('test-website-id', $script->attr('data-website-id'));
        $this->assertSame('false', $script->attr('data-auto-track'));
        $this->assertStringContainsString('location.pathname', $script->attr('onload'));
    }

    public function testSearchConsoleVerificationTag(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/');
        $this->assertCount(0, $crawler->filter('meta[name="google-site-verification"]'), 'no tag without a code');

        self::ensureKernelShutdown();
        $_SERVER['GOOGLE_SITE_VERIFICATION'] = $_ENV['GOOGLE_SITE_VERIFICATION'] = 'test-code';
        try {
            $client = static::createClient();
            $crawler = $client->request('GET', '/');
        } finally {
            $_SERVER['GOOGLE_SITE_VERIFICATION'] = $_ENV['GOOGLE_SITE_VERIFICATION'] = '';
        }

        $this->assertSame('test-code', $crawler->filter('meta[name="google-site-verification"]')->attr('content'));
    }

    private function feature(string $name): bool
    {
        return static::getContainer()->getParameter('app.features')[$name];
    }
}
