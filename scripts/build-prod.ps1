# Construit une version de production prête à envoyer chez Hostinger.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-prod.ps1
#
# Résultat : build\flotor-prod.zip, à décompresser dans public_html/ du domaine.
# Le contenu de public_html/ :
#   .htaccess        redirige toutes les requêtes vers public/ (le reste du projet n'est pas accessible)
#   .env.local.php   APP_ENV=prod (donc debug désactivé) et un APP_SECRET généré (ou repris de build\app_secret.txt)
#   public/ src/ config/ templates/ vendor/ ...

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$buildDir = Join-Path $root 'build'
$out = Join-Path $buildDir 'flotor-prod'
$zip = Join-Path $buildDir 'flotor-prod.zip'

# Fichiers versionnés + nouveaux fichiers non ignorés, dans leur état actuel (modifications non committées incluses).
$exclude = '^(tests/|scripts/|\.env\.dev$|\.env\.test$|phpunit\.dist\.xml$|package\.json$|AGENTS\.md$|CLAUDE\.md$|README\.md$|\.editorconfig$|\.gitignore$)'
$files = git -C $root ls-files --cached --others --exclude-standard | Where-Object { $_ -notmatch $exclude }

if (Test-Path $out) { Remove-Item $out -Recurse -Force }
foreach ($f in $files) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src -PathType Leaf)) { continue }  # fichier supprimé mais pas encore committé
    $dst = Join-Path $out $f
    New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
    Copy-Item $src $dst
}

# Le secret est conservé d'un build à l'autre (build/ n'est pas versionné).
$secretFile = Join-Path $buildDir 'app_secret.txt'
if (-not (Test-Path $secretFile)) {
    -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) | Set-Content $secretFile -NoNewline
}

Push-Location $out
try {
    $env:COMPOSER = $null
    $env:APP_ENV = 'prod'
    $env:APP_DEBUG = '0'
    $env:APP_SECRET = (Get-Content $secretFile -Raw).Trim()

    composer install --no-dev --optimize-autoloader --no-interaction --no-progress
    if ($LASTEXITCODE) { throw 'composer install a échoué' }
    php bin/console asset-map:compile
    if ($LASTEXITCODE) { throw 'asset-map:compile a échoué' }
    composer dump-env prod
    if ($LASTEXITCODE) { throw 'composer dump-env a échoué' }

    # Le cache se régénère sur le serveur (chemins différents).
    if (Test-Path var) { Remove-Item var -Recurse -Force }

    # public_html/ est la racine web chez Hostinger : tout est redirigé vers public/.
    @'
<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteRule ^index\.php(?:/(.*)|$) /$1 [R=301,L]
    RewriteRule ^(.*)$ public/$1 [L]
</IfModule>
'@ | Set-Content .htaccess -Encoding ascii
}
finally {
    Pop-Location
    Remove-Item Env:APP_ENV, Env:APP_DEBUG, Env:APP_SECRET -ErrorAction SilentlyContinue
}

if (Test-Path $zip) { Remove-Item $zip -Force }
# tar produit des chemins avec « / » (Compress-Archive de PowerShell 5 met des « \ », mal lus sous Linux).
tar -a -cf $zip -C $out .
if ($LASTEXITCODE) { throw 'création du zip échouée' }
Write-Host "OK : $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) Mo)"
