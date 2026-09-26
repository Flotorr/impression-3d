<?php

namespace App\Faq;

use Symfony\Component\DependencyInjection\Attribute\Autowire;

/**
 * FAQ entries from config/faq.yaml, adapted to the features currently switched on.
 *
 * Answers that describe advanced fields have a Simple-mode variant (`answer_simple`)
 * that stays true while those fields are not offered.
 */
final class FaqProvider
{
    /**
     * @param list<array{question: string, answer: string, answer_simple?: string}> $faq
     * @param array{advanced_mode: bool, legal_page: bool}                          $features
     */
    public function __construct(
        #[Autowire('%calculator.faq%')] private readonly array $faq,
        #[Autowire('%app.features%')] private readonly array $features,
    ) {
    }

    /**
     * @return list<array{question: string, answer: string}>
     */
    public function all(): array
    {
        return array_map(fn (array $item): array => [
            'question' => $item['question'],
            'answer' => $this->features['advanced_mode'] ? $item['answer'] : ($item['answer_simple'] ?? $item['answer']),
        ], $this->faq);
    }
}
