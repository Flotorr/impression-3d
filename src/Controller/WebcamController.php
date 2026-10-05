<?php

namespace App\Controller;

use App\Webcam\WebcamFinder;
use App\Webcam\WebcamQuery;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Attribute\MapQueryString;
use Symfony\Component\Routing\Attribute\Route;

/** The webcam closest to a beach of the wave tank, through the server so the Windy key is never sent to the browser. */
final class WebcamController extends AbstractController
{
    #[Route('/api/webcam', name: 'api_webcam', methods: ['GET'])]
    public function __invoke(
        #[MapQueryString(validationFailedStatusCode: Response::HTTP_UNPROCESSABLE_ENTITY)] WebcamQuery $query,
        WebcamFinder $finder,
    ): JsonResponse {
        $webcam = $finder->nearest($query->lat, $query->lon);
        $response = $this->json(null === $webcam ? ['available' => false] : ['available' => true, ...get_object_vars($webcam)]);
        $response->setPrivate();
        $response->setMaxAge(300);

        return $response;
    }
}
