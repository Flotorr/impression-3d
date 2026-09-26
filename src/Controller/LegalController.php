<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

final class LegalController extends AbstractController
{
    /**
     * @param array{advanced_mode: bool, legal_page: bool} $features
     */
    #[Route('/mentions-legales', name: 'legal')]
    public function index(#[Autowire('%app.features%')] array $features): Response
    {
        if (!$features['legal_page']) {
            throw $this->createNotFoundException();
        }

        return $this->render('legal/mentions.html.twig');
    }
}
