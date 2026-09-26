# Calculateur de coût d'impression 3D (flotor.fr)

Calculateur gratuit du coût réel d'une impression 3D et du prix de vente conseillé.
Symfony 8.1 + Twig, AssetMapper, Stimulus. Pas de base de données, pas de compte, pas de build Node.

## Lancer en local

```bash
composer install                    # télécharge aussi Stimulus dans assets/vendor/ (non versionné)
symfony server:start                # ou : php -S 127.0.0.1:8000 -t public
```

Page : <http://127.0.0.1:8000/> (redirige vers `/calculateur-cout-impression-3d`).
PHP 8.4+ requis.

## Tests

```bash
npm test            # module de calcul et libs JS (node --test, aucune dépendance)
php bin/phpunit     # smoke tests SEO (H1 unique, canonical, JSON-LD, sitemap…)
```

## Où modifier quoi

| Je veux… | Fichier |
| --- | --- |
| Changer les valeurs par défaut du formulaire | `config/calculator.yaml` (`calculator.defaults`) |
| Renseigner les imprimantes (puissance, prix) | `config/calculator.yaml` (`calculator.printers`), puis passer `verify` à `false` |
| Modifier la FAQ (page `/faq-impression-3d` + JSON-LD `FAQPage`) | `config/faq.yaml` (texte brut, sans HTML) ; variantes `answer_simple` tant que le mode Avancé est désactivé |
| Changer le domaine (canonical, Open Graph) | `app.site_url` dans `config/services.yaml` |
| Compléter les mentions légales | `templates/legal/mentions.html.twig` (repérer les `[À COMPLÉTER]`) |
| Adapter le sitemap / robots | `public/sitemap.xml`, `public/robots.txt` (domaine écrit en dur) |
| Changer une formule | `assets/lib/cost-calculator.js` + ses tests (`tests/js/`) |

**À FAIRE avant la mise en ligne** : toutes les valeurs marquées `# À VÉRIFIER` dans `config/calculator.yaml`
sont des valeurs de départ, pas des chiffres réels ; les puissances et prix d'imprimantes sont volontairement vides
(`null` = le champ n'est pas prérempli) ; les mentions légales contiennent des champs à compléter ;
relire la FAQ (questions fiscales, page `/faq-impression-3d`) ; vérifier le JSON-LD avec le test des résultats enrichis de Google.

## Fonctionnalités désactivées (interrupteurs)

`app.features` dans `config/services.yaml` :

| Interrupteur | Off (actuel) | On |
| --- | --- | --- |
| `advanced_mode` | Mode Simple uniquement (filament + électricité + marge). Formulaire, résultat, formules, FAQ, meta description et JSON-LD n'annoncent que ce qui existe. | Mode Avancé complet et option micro-entreprise. |
| `legal_page` | `/mentions-legales` répond 404 et le lien du pied de page disparaît. | Page et lien réactivés. |

Rien n'a été supprimé : le code du mode Avancé (`assets/lib/cost-calculator.js`, tests inclus) reste en place.
Pour réactiver la page légale, décommenter aussi son `<url>` dans `public/sitemap.xml` (le test PHPUnit le vérifie).
Après changement en production : `APP_ENV=prod php bin/console cache:clear`.
Un ancien lien partagé en mode Avancé reste lisible : les champs devenus inutiles sont ignorés.

## Mesure d'audience (Umami)

Umami Cloud, sans cookie (pas de bandeau de consentement). Actif seulement si `UMAMI_WEBSITE_ID` est renseigné,
dans `.env.prod` : le dev et les tests n'envoient rien. Le suivi automatique est coupé, car le calculateur réécrit l'URL
à chaque saisie ; une seule page vue est envoyée, sans query string (les liens de partage contiennent les valeurs saisies).
Événements : `calcul` (une fois par visite, au premier changement), `lien-partage`, `imprimante` (modèle choisi).
Le paragraphe correspondant des mentions légales s'affiche automatiquement quand Umami est actif.

Google Search Console (propriété « Préfixe d'URL », méthode « Balise HTML ») : mettre la valeur `content` de la balise
dans `GOOGLE_SITE_VERIFICATION` (`.env.prod`) ; la balise `<meta name="google-site-verification">` est alors ajoutée à toutes les pages.

## Architecture

- `assets/lib/cost-calculator.js` : calcul pur, sans DOM, sans arrondi (l'arrondi est uniquement à l'affichage).
  Autres modules purs : `number-format.js` (virgule décimale, `Intl.NumberFormat('fr-FR')`), `share-params.js`
  (état ⇄ query string), `donut.js` (géométrie de l'anneau), `messages.js` (messages d'erreur en français).
- `assets/controllers/calculator_controller.js` : Stimulus, lit le formulaire, appelle les libs, met à jour le DOM.
- Pages : `/calculateur-cout-impression-3d` (JSON-LD `WebApplication`), `/faq-impression-3d` (JSON-LD `FAQPage`),
  `/mentions-legales` (désactivée), `/` redirige vers le calculateur. `src/Faq/FaqProvider.php` prépare la FAQ.
- Le formulaire, les résultats et les textes SEO sont rendus côté serveur (Twig) ; le JS ne fait que mettre à jour.
- Le lien de partage sérialise tous les paramètres dans la query string ; le `canonical` ne la contient jamais.

### Règles de calcul (choix par défaut)

- Filament : `g × prix bobine ÷ poids bobine` ; la purge est comptée au même prix par gramme.
- Taux d'échec : `coût de production × taux`, avec production = filament + purge + électricité + usure
  (ni main d'œuvre ni extras).
- Marge : majoration sur le coût, `prix conseillé = coût total × (1 + marge)`.
- Micro-entreprise : `prix à facturer = prix conseillé ÷ (1 − taux de cotisations)`. La TVA n'est pas gérée.
- Mode Simple : filament + électricité + marge ; les champs avancés sont ignorés.

## Déploiement

Hostinger (mutualisé, racine web `public_html/`) : `powershell -ExecutionPolicy Bypass -File scripts\build-prod.ps1`
produit `build/flotor-prod.zip` (dépendances sans dev, assets compilés, `.env.local.php` de prod, `.htaccess` racine
qui redirige vers `public/`). Le décompresser dans `public_html/`, avec PHP 8.4+ sélectionné dans hPanel.

Autre serveur, étapes manuelles :

```bash
composer install --no-dev --optimize-autoloader
# APP_ENV=prod, APP_DEBUG=0 et APP_SECRET définis (variables d'environnement ou `composer dump-env prod`)
APP_ENV=prod php bin/console asset-map:compile     # assets versionnés dans public/assets/
APP_ENV=prod php bin/console cache:clear
```

Le serveur web doit pointer sur `public/`. Activer la compression (gzip/brotli) et un cache long sur `/assets/*`
(les fichiers ont un hash dans leur nom). Après un changement de code, relancer `asset-map:compile`.
Ne pas laisser `public/assets/` sur une machine de développement : il masque les assets en cours de modification.

Poids mesuré en production : environ 24 Ko de JS et CSS en gzip (dont Stimulus, 11 Ko) et 6 Ko de HTML.
Aucune ressource externe.
