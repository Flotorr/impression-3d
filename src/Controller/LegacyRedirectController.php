<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

/**
 * Pages of the former 3D printing calculator, still indexed by search engines and bookmarked:
 * visitors land on the current home page instead of a 404.
 */
final class LegacyRedirectController extends AbstractController
{
    #[Route('/calculateur-cout-impression-3d', name: 'legacy_calculator')]
    #[Route('/faq-impression-3d', name: 'legacy_faq')]
    public function __invoke(): RedirectResponse
    {
        return $this->redirectToRoute('home', [], Response::HTTP_MOVED_PERMANENTLY);
    }
}
