<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

final class SandboxController extends AbstractController
{
    #[Route('/', name: 'home')]
    public function index(): Response
    {
        return $this->render('sandbox/index.html.twig');
    }

    /** The wave tank: the real swell of a coastal town, with a surfer for scale (`?ville=` picks the town). */
    #[Route('/houle', name: 'ocean')]
    public function ocean(): Response
    {
        return $this->render('ocean/index.html.twig');
    }
}
