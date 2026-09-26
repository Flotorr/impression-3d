<?php

namespace App\Tests\Controller;

use Symfony\Bundle\FrameworkBundle\Test\WebTestCase;
use Symfony\Component\DomCrawler\Crawler;

/**
 * Smoke tests for SEO-critical markup: status codes, single H1, canonical, structured data.
 */
final class PagesTest extends WebTestCase
{
    private const CALCULATOR_PATH = '/calculateur-cout-impression-3d';
    private const FAQ_PATH = '/faq-impression-3d';

    public function testHomeRedirectsPermanentlyToCalculator(): void
    {
        $client = static::createClient();
        $client->request('GET', '/');

        $this->assertResponseStatusCodeSame(301);
        $this->assertResponseRedirects(self::CALCULATOR_PATH, 301);
    }

    public function testCalculatorPageBasics(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::CALCULATOR_PATH);

        $this->assertResponseIsSuccessful();
        $this->assertCount(1, $crawler->filter('h1'), 'exactly one H1');
        $this->assertSame('fr', $crawler->filter('html')->attr('lang'));

        $this->assertSelectorTextContains('h2', 'Résultat');
        $h2 = $crawler->filter('h2')->each(static fn (Crawler $n) => trim($n->text()));
        $this->assertContains('Comment est calculé le coût ?', $h2);
        $this->assertCount(0, $crawler->filter('#faq-title'), 'the FAQ lives on its own page');
        $this->assertSame('/faq-impression-3d', $crawler->filter('.cta a')->attr('href'), 'link to the FAQ page');
    }

    public function testCanonicalIgnoresQueryString(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::CALCULATOR_PATH.'?m=a&w=100');

        $this->assertSame(
            'https://flotor.fr'.self::CALCULATOR_PATH,
            $crawler->filter('link[rel="canonical"]')->attr('href'),
        );
        $this->assertSame(
            'https://flotor.fr'.self::CALCULATOR_PATH,
            $crawler->filter('meta[property="og:url"]')->attr('content'),
        );
    }

    public function testMetaTags(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::CALCULATOR_PATH);

        $title = $crawler->filter('title')->text();
        $description = $crawler->filter('meta[name="description"]')->attr('content');

        $this->assertLessThanOrEqual(65, mb_strlen($title), 'title should stay short enough for search results');
        $this->assertGreaterThanOrEqual(80, mb_strlen($description));
        $this->assertLessThanOrEqual(165, mb_strlen($description));
        $this->assertSame($title, $crawler->filter('meta[property="og:title"]')->attr('content'));
        $this->assertSame('https://flotor.fr/og-image.png', $crawler->filter('meta[property="og:image"]')->attr('content'));
    }

    public function testCalculatorPageHasWebApplicationDataOnly(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::CALCULATOR_PATH);

        $types = [];
        foreach ($crawler->filter('script[type="application/ld+json"]') as $script) {
            $types[] = json_decode($script->textContent, true, flags: JSON_THROW_ON_ERROR)['@type'];
        }

        $this->assertSame(['WebApplication'], $types, 'FAQPage markup belongs on the FAQ page');
    }

    public function testFaqPageBasics(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::FAQ_PATH);

        $this->assertResponseIsSuccessful();
        $this->assertCount(1, $crawler->filter('h1'), 'exactly one H1');
        $this->assertSame('https://flotor.fr'.self::FAQ_PATH, $crawler->filter('link[rel="canonical"]')->attr('href'));
        $this->assertLessThanOrEqual(65, mb_strlen($crawler->filter('title')->text()));
        $description = $crawler->filter('meta[name="description"]')->attr('content');
        $this->assertGreaterThanOrEqual(80, mb_strlen($description));
        $this->assertLessThanOrEqual(165, mb_strlen($description));

        // Each question is an H2 under the single H1.
        $questions = $crawler->filter('main article h2');
        $this->assertGreaterThanOrEqual(5, $questions->count());
        $this->assertLessThanOrEqual(6, $questions->count());

        $this->assertSame(self::CALCULATOR_PATH, $crawler->filter('.cta a')->attr('href'), 'link back to the calculator');
    }

    public function testFaqStructuredDataMatchesVisibleFaq(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::FAQ_PATH);

        $scripts = $crawler->filter('script[type="application/ld+json"]');
        $this->assertCount(1, $scripts);
        $data = json_decode($scripts->first()->text(null, false), true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame('FAQPage', $data['@type']);
        $this->assertSame('https://schema.org', $data['@context']);

        // Same questions and same answers as the visible FAQ.
        $articles = $crawler->filter('main article');
        $visibleQuestions = $articles->filter('h2')->each(static fn (Crawler $n) => trim($n->text()));
        $visibleAnswers = $articles->filter('p')->each(static fn (Crawler $n) => trim(preg_replace('/\s+/', ' ', $n->text())));
        $questions = $data['mainEntity'];
        $this->assertSame($visibleQuestions, array_column($questions, 'name'));
        $this->assertSame($visibleAnswers, array_column(array_column($questions, 'acceptedAnswer'), 'text'));
    }

    public function testNavigationLinksToTheFaqPage(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::CALCULATOR_PATH);

        $this->assertGreaterThanOrEqual(2, $crawler->filter('a[href="'.self::FAQ_PATH.'"]')->count(), 'top bar and footer');
    }

    public function testLegalPageFollowsItsFeatureSwitch(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', '/mentions-legales');

        if (!$this->feature('legal_page')) {
            $this->assertResponseStatusCodeSame(404);
            $home = $client->request('GET', self::CALCULATOR_PATH);
            $this->assertCount(0, $home->filter('a[href="/mentions-legales"]'), 'no footer link while the page is off');

            return;
        }

        $this->assertResponseIsSuccessful();
        $this->assertCount(1, $crawler->filter('h1'));
        $this->assertGreaterThan(0, $crawler->filter('mark.todo')->count(), 'placeholders are marked');
        $this->assertSame(
            'https://flotor.fr/mentions-legales',
            $crawler->filter('link[rel="canonical"]')->attr('href'),
        );
    }

    public function testAdvancedModeFollowsItsFeatureSwitch(): void
    {
        $client = static::createClient();
        $crawler = $client->request('GET', self::CALCULATOR_PATH);

        if ($this->feature('advanced_mode')) {
            $this->assertCount(1, $crawler->filter('input[type="radio"][name="mode"][value="advanced"]'));
            $this->assertGreaterThan(0, $crawler->filter('[data-advanced]')->count());

            return;
        }

        // Simple only: the calculator still gets its mode, from a hidden input.
        $this->assertCount(1, $crawler->filter('input[type="hidden"][name="mode"][value="simple"]'));
        $this->assertCount(0, $crawler->filter('input[type="radio"][name="mode"]'));
        $this->assertCount(0, $crawler->filter('[data-advanced]'));
        foreach (['purgeG', 'printerPriceEur', 'lifespanH', 'failureRatePct', 'prepMin', 'extrasEur', 'microRatePct'] as $field) {
            $this->assertCount(0, $crawler->filter(sprintf('[name="%s"]', $field)), $field);
        }
        // Fields that remain
        foreach (['filamentWeightG', 'spoolPriceEur', 'durationHours', 'powerW', 'kwhPriceEur', 'marginPct'] as $field) {
            $this->assertCount(1, $crawler->filter(sprintf('[name="%s"]', $field)), $field);
        }
        // Text and metadata must not promise what is not offered.
        $page = $crawler->filter('body')->text().$crawler->filter('meta[name="description"]')->attr('content');
        $this->assertStringNotContainsStringIgnoringCase('mode avancé', $page);
        $this->assertStringNotContainsStringIgnoringCase('option micro-entreprise', $page);
        $this->assertStringNotContainsString('Prix à facturer', $page);
        $this->assertStringNotContainsString('Renseignez un taux d\'échec', $page);
    }

    public function testStaticSeoFilesListTheRealPages(): void
    {
        $sitemap = file_get_contents(__DIR__.'/../../public/sitemap.xml');
        $this->assertStringContainsString('<loc>https://flotor.fr'.self::CALCULATOR_PATH.'</loc>', $sitemap);
        $this->assertStringContainsString('<loc>https://flotor.fr'.self::FAQ_PATH.'</loc>', $sitemap);
        $xml = simplexml_load_string($sitemap);
        $this->assertNotFalse($xml, 'sitemap is valid XML');
        $urls = [];
        foreach ($xml->url as $url) { // XML comments are ignored by the parser
            $urls[] = (string) $url->loc;
        }
        $legalListed = in_array('https://flotor.fr/mentions-legales', $urls, true);
        $this->assertSame($this->feature('legal_page'), $legalListed, 'sitemap lists the legal page only while it is on');

        $robots = file_get_contents(__DIR__.'/../../public/robots.txt');
        $this->assertStringContainsString('Sitemap: https://flotor.fr/sitemap.xml', $robots);
    }

    private function feature(string $name): bool
    {
        return static::getContainer()->getParameter('app.features')[$name];
    }
}
