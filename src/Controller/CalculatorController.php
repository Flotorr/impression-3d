<?php

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\DependencyInjection\Attribute\Autowire;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

final class CalculatorController extends AbstractController
{
    #[Route('/', name: 'home')]
    public function home(): RedirectResponse
    {
        return $this->redirectToRoute('calculator', [], Response::HTTP_MOVED_PERMANENTLY);
    }

    /**
     * @param array<string, scalar|null>                                                                              $defaults
     * @param list<array{id: string, name: string, power_w: int|float|null, price_eur: int|float|null, verify: bool}> $printers
     */
    #[Route('/calculateur-cout-impression-3d', name: 'calculator')]
    public function index(
        #[Autowire('%calculator.defaults%')] array $defaults,
        #[Autowire('%calculator.printers%')] array $printers,
    ): Response {
        return $this->render('calculator/index.html.twig', [
            'defaults' => $defaults,
            'printers' => $printers,
        ]);
    }
}
