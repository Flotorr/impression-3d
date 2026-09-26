<?php

namespace App\Controller;

use App\Faq\FaqProvider;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

final class FaqController extends AbstractController
{
    #[Route('/faq-impression-3d', name: 'faq')]
    public function index(FaqProvider $faq): Response
    {
        return $this->render('faq/index.html.twig', [
            'faq' => $faq->all(),
        ]);
    }
}
