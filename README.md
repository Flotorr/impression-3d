# Bac à sable 3D : sable et eau (flotor.fr)

Démo technique : un bac à sable en verre où l'on creuse, entasse et pousse le sable, sculpte l'argile et la roche,
verse de la lave, pendant que l'eau s'écoule, remplit les creux et creuse des rivières. Toute la physique tourne sur la carte graphique (WebGL 2).
Symfony 8.1 + Twig, AssetMapper, Stimulus, Three.js (importmap, pas de build Node). Pas de base de données.

## Lancer en local

```bash
composer install                    # télécharge aussi Stimulus et Three.js dans assets/vendor/ (non versionné)
symfony server:start                # ou : php -S 127.0.0.1:8000 -t public
```

Pages : <http://127.0.0.1:8000/> (bac à sable) et <http://127.0.0.1:8000/houle> (bac à houle). PHP 8.4+ et un navigateur avec WebGL 2 requis.

## Tests

```bash
npm test            # constantes physiques, outils, sources, coordonnées (node --test, aucune dépendance)
php bin/phpunit     # page, SEO (canonical, meta, JSON-LD, sitemap), redirections, Umami, Search Console
```

## Où modifier quoi

| Je veux… | Fichier |
| --- | --- |
| Régler la physique (angles de talus, érosion, pluie, sources, argile, roche, lave, pas de temps) | `PHYSICS` dans `assets/lib/sand-physics.js` |
| Ajouter ou modifier un outil | `TOOLS` dans `assets/lib/sand-physics.js` (mode et débit), puis le mode dans les shaders de pinceau |
| Modifier la simulation (eau, lave, éboulements, érosion) | `assets/lib/sand-sim-shaders.js` (GLSL) et `assets/lib/sand-sim.js` (enchaînement des passes) |
| Modifier le rendu (sable, eau, coupe vue à travers la vitre, verre, pluie, cascade, flaque) | `assets/lib/sand-render-shaders.js` |
| Vitres (survol du marteau, éclats, flaques), gouttes de pluie, cascade, vapeur | `assets/lib/sand-effects.js` |
| Objets flottants (modèles, physique sur GPU, nombre maximal) | `assets/lib/sand-objects.js`, `OBJECT_TYPES` et `MAX_OBJECTS` dans `sand-physics.js` |
| Caméra, bac, éclairage, interaction souris / tactile | `assets/lib/sand-scene.js` |
| Barre d'outils, réglages, raccourcis, capture | `assets/controllers/sandbox_controller.js`, `templates/sandbox/index.html.twig` |
| Image de partage (Open Graph, 1200 × 630) | `public/og-image.png` |
| Compléter les mentions légales | `templates/legal/mentions.html.twig` (repérer les `[À COMPLÉTER]`) |

## Fonctionnement

La grille fait 256 × 256 cellules ; chaque état est une texture flottante (RGBA) mise à jour par des passes plein écran.
Chaque colonne est une pile : roche au fond, puis argile, puis sable (texture `terrain`), avec la lave puis l'eau par-dessus.
Par image : pinceau (sable, puis eau, sources et pluie), puis 1 à 8 sous-pas de 4 ms. Les passes de l'eau tournent
sur leur propre horloge (curseur « Vitesse de l'eau », ×0,25 à ×3) : en dessous de 1 elles sautent des sous-pas,
au-dessus elles tournent plusieurs fois par sous-pas, sans jamais changer le pas de temps (le schéma reste stable).

1. **Éboulements** : chaque cellule compare sa hauteur à ses 8 voisines (diagonales à √2). Au-delà de l'angle de talus
   (sec 32°, humide jusqu'à 50°, sous l'eau 25°), elle cède la moitié du plus grand excédent, réparti selon la pente :
   la masse est conservée exactement et les tas forment des cônes ronds. Seul le sable s'éboule : l'argile garde
   la forme qu'on lui donne, la roche ne bouge jamais.
1. **Lave** : le même modèle de tuyaux que l'eau, mais visqueux (fluidité × température²) ; elle transporte sa chaleur,
   refroidit en une quarantaine de secondes à l'air, presque aussitôt dans l'eau (avec de la vapeur), puis durcit
   en roche, qui englobe le sable et l'argile qu'elle recouvrait.
2. **Eau** (modèle des « tuyaux virtuels », Mei et al. 2007) : le débit vers chaque voisine augmente avec la différence
   de niveau sable + eau, limité à l'eau disponible ; la hauteur et la vitesse s'en déduisent. Les vitres sont des murs.
3. **Érosion** : la capacité de transport croît avec la pente et la vitesse ; l'eau arrache le sable, puis l'argile
   (sept fois plus lentement), jamais la roche ; elle redépose du sable, et le sédiment est transporté avec le courant.
4. **Humidité** : le sable mouillé est plus sombre, tient plus raide, sèche lentement.

L'eau est conservée : elle ne disparaît jamais d'elle-même (ni évaporation ni infiltration), seulement par l'éponge
ou par une vitre cassée. La pluie remplit donc peu à peu le bac.

Panneau « Vider / remplir » : retirer le sable, la lave ou l'eau, « Bac vide » (tout retirer, roche comprise) et
« Remplir d'eau » (niveau `fillLevel`, environ la moitié des vitres : plus profond, les vagues iraient trop vite pour
le pas de temps). « Bac vide » puis « Remplir d'eau » donne un bac rempli d'eau seulement, où les objets flottent.

**Pluie** : des gouttes (segments animés dans le vertex shader) tombent du ciel en biais et s'arrêtent là où elles
rencontrent le sable ou l'eau, lus dans les textures de la simulation ; des ronds se forment sur l'eau et le ciel
s'assombrit. **Marteau** : un clic sur une vitre la brise (éclats qui tombent sur la table). De ce côté, la simulation
ouvre le bord sur l'extérieur : l'eau se déverse (particules en cascade) et le sable s'écoule jusqu'à retrouver sa pente.
Une flaque grandit sur la table, à partir des profondeurs lues sur le bord toutes les 10 images.

**Objets flottants** : leur état (position, vitesse, cap) tient dans une petite texture mise à jour sur le GPU. À flot,
chaque objet prend la vitesse de l'eau sous lui et glisse le long de la pente de la surface ; échoué, il s'arrête ;
les objets se repoussent et rebondissent sur les vitres. Par une vitre cassée, ils sortent avec l'eau, tombent
en chute libre et restent sur le socle en bois ou sur la table. Le rendu (maillages instanciés) lit cette texture dans le
vertex shader pour poser chaque objet sur l'eau, incliné avec la surface : rien n'est relu côté CPU.

**Bac à houle** (page `/houle`, séparée du bac à sable ; un sélecteur en haut passe de l'un à l'autre) : une ville
côtière (`?ville=`, Biarritz par défaut) est géocodée puis sa houle du moment est demandée à Open-Meteo, depuis le
navigateur (`assets/lib/ocean-data.js`, `assets/controllers/ocean_controller.js`). Pas d'outils sur cette page : la souris
ne fait que tourner et zoomer (API gratuite pour un usage non commercial, sans clé ; attribution CC BY 4.0 affichée sur la fiche). Le bac
devient une plage et une rangée de cellules au fond pousse la houle comme le batteur d'un bassin à houle. Tout est à
l'échelle du surfeur (1,75 m, `OCEAN.metre`) : hauteurs et longueurs × `metre`, durées × √`metre` (similitude de
Froude). Rafraîchi toutes les 15 minutes. Ce sont des données de modèles de vagues, pas de mesures de bouées.
La houle est faite de deux trains (périodes à 9 % d'écart, angles légèrement différents : des séries de vagues plus
grosses toutes les ~11 vagues), la plage a une barre de sable immergée, et une crête plus haute que ~la moitié de la
profondeur déferle (perte d'énergie dans la passe des flux, écume blanche au rendu).

**Webcam de la plage** : `/api/webcam?lat=&lon=` (`WebcamController`, `src/Webcam/WebcamFinder.php`) cherche avec la
[Windy Webcams API](https://api.windy.com/webcams) la webcam la plus proche dans un rayon de 15 km (plage ou côte
d'abord) et la met en cache 8 minutes (les liens d'images gratuits expirent après 10). La clé reste sur le serveur :
la mettre dans `.env.local` (`WINDY_WEBCAMS_KEY=...`, compte gratuit sur api.windy.com). Sans clé, la page n'affiche
pas de webcam. Le crédit « Webcams fournies par windy.com » est obligatoire et affiché sous l'image. Seules les webcams
de plage ou de côte sont retenues. L'offre gratuite de Windy n'a pas de flux en direct : la page montre l'image
la plus récente, le lecteur officiel de Windy (timelapse de la journée, intégrable) et un bouton « Voir le direct » vers
la page de l'exploitant de la caméra (Viewsurf, Gosurf…), dont le flux n'est pas intégré au site. Les cinq spots proposés ont les coordonnées de leur plage (la recherche par nom peut
tomber dans les terres ou sur un homonyme). `scripts/build-prod.ps1` reprend la clé du `.env.local` du poste pour la prod.

La souris vise le terrain en lisant sur le GPU la hauteur sous le pointeur (deux allers-retours). Le rendu s'arrête
quand le bac sort de l'écran ou que l'onglet est masqué. Sans `EXT_color_buffer_float`, la simulation passe en
demi-précision (moins fine pour l'érosion).

Commandes : clic gauche ou un doigt pour l'outil, clic droit ou deux doigts pour tourner, molette ou pincement pour
zoomer vers le point sous le pointeur. Les outils sont en colonne à gauche (en bas sur téléphone). Raccourcis `1` à `9`, `0` et `O` (objets) pour les onze outils, `[` et `]` pour la taille. La pelle (« Creuser ») retire
le sable, mord plus lentement dans l'argile et à peine dans la roche.

Les anciennes URL du calculateur (`/calculateur-cout-impression-3d`, `/faq-impression-3d`) redirigent en 301 vers `/`.

## Fonctionnalités désactivées (interrupteurs)

`app.features` dans `config/services.yaml` : `legal_page` (off : `/mentions-legales` répond 404 et le lien du pied
de page disparaît). Pour la réactiver, décommenter aussi son `<url>` dans `public/sitemap.xml` (le test PHPUnit le vérifie).
Après changement en production : `APP_ENV=prod php bin/console cache:clear`.

## Mesure d'audience (Umami)

Umami Cloud, sans cookie (pas de bandeau de consentement). Actif seulement si `UMAMI_WEBSITE_ID` est renseigné,
dans `.env.prod` : le dev et les tests n'envoient rien. Une seule page vue, sans query string.
Événements : `outil` (`nom` de l'outil choisi), `objet` (premier objet posé), `pluie`, `vitre-cassee` (`cote`), `bac-vide`, `remplir`, `ocean` (`ville`), `timelapse`, `nouvelles-dunes`, `capture-png`.
Le paragraphe correspondant des mentions légales s'affiche automatiquement quand Umami est actif.

Google Search Console (propriété « Préfixe d'URL », méthode « Balise HTML ») : mettre la valeur `content` de la balise
dans `GOOGLE_SITE_VERIFICATION` (`.env.prod`) ; la balise `<meta name="google-site-verification">` est alors ajoutée à toutes les pages.

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
(les fichiers ont un hash dans leur nom) : Three.js pèse environ 750 Ko non compressé.
Ne pas laisser `public/assets/` sur une machine de développement : il masque les assets en cours de modification.
