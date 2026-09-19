# Assemble a Cloudflare Pages upload directory that contains only the app.
# Wrangler Pages does not honour .wranglerignore / .gitignore / .assetsignore.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root ".pages-publish"

if (Test-Path $Out) {
  Remove-Item $Out -Recurse -Force
}
New-Item -ItemType Directory -Path $Out | Out-Null

foreach ($name in @("counter", "store")) {
  $src = Join-Path $Root $name
  if (-not (Test-Path $src)) {
    throw "missing $src"
  }
  Copy-Item -Path $src -Destination (Join-Path $Out $name) -Recurse
}

foreach ($name in @("index.html", "_headers", "_redirects")) {
  $src = Join-Path $Root $name
  if (Test-Path $src) {
    Copy-Item -Path $src -Destination (Join-Path $Out $name)
  }
}

Write-Host "Assembled $Out (counter/, store/, index.html, _headers, _redirects)."
Write-Host "Excluded tools/, deploy/, prototypes, pocket/, stack/, night/, bench/."
Write-Host "Deploy: npx wrangler pages deploy `"$Out`" --project-name handy-book"
