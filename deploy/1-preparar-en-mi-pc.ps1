# =============================================================================
# Cuadra - preparar los DATOS para el VPS desde tu PC (Windows)
#   (el codigo va por GitHub: git push en tu PC, git clone / git pull en el VPS)
#   Desde la carpeta del proyecto (cuadra), con Docker Desktop abierto:
#   powershell -ExecutionPolicy Bypass -File deploy\1-preparar-en-mi-pc.ps1
#
# Crea en la carpeta deploy\:
#   cuadra.dump           respaldo completo de tu base local (todas las empresas)
#   .env.production       configuracion del VPS (con TU MISMO AUTH_SECRET)
#   conteo-local.txt      cuantas empresas/usuarios/ventas tienes, para comparar
# =============================================================================
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# --- Leer el .env local ---
if (-not (Test-Path .env)) { throw 'No encuentro el archivo .env en la carpeta del proyecto' }
$envVars = @{}
foreach ($line in Get-Content .env) {
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') { $envVars[$matches[1]] = $matches[2].Trim().Trim('"') }
}
$user = if ($envVars.POSTGRES_USER) { $envVars.POSTGRES_USER } else { 'cuadra' }
$db   = if ($envVars.POSTGRES_DB)   { $envVars.POSTGRES_DB }   else { 'cuadra' }
if (-not $envVars.AUTH_SECRET) { throw 'Tu .env no tiene AUTH_SECRET' }

# --- 1. Respaldo de la base ---
Write-Host '-> Respaldando la base local...' -ForegroundColor Cyan
$container = (docker compose ps -q postgres).Trim()
if (-not $container) { throw 'El Postgres local no esta corriendo. Abre Docker Desktop y corre: pnpm db:up' }
docker exec $container pg_dump -U $user -d $db -Fc -f /tmp/cuadra.dump
if ($LASTEXITCODE -ne 0) { throw 'pg_dump fallo' }
# docker cp (no redirigir con >, PowerShell corrompe los archivos binarios)
docker cp "${container}:/tmp/cuadra.dump" deploy\cuadra.dump
docker exec $container rm -f /tmp/cuadra.dump
$size = [math]::Round((Get-Item deploy\cuadra.dump).Length / 1MB, 2)
Write-Host "   OK deploy\cuadra.dump ($size MB)" -ForegroundColor Green

$count = docker exec $container psql -U $user -d $db -tA -c "select 'empresas: '||(select count(*) from tenants)||' · usuarios: '||(select count(*) from users)||' · ventas: '||(select count(*) from sales_records)"
[IO.File]::WriteAllText("$PWD\deploy\conteo-local.txt", ($count | Out-String).Trim(), (New-Object Text.UTF8Encoding $false))
Write-Host "   En tu PC: $count" -ForegroundColor Green

# --- 2. Configuracion del VPS ---
$prod = 'deploy\.env.production'
if (Test-Path $prod) {
  Write-Host "-> $prod ya existe, no lo toco" -ForegroundColor Yellow
} else {
  $chars = [char[]]'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $pgPass = -join (1..32 | ForEach-Object { $chars | Get-Random })
  $lines = @(
    '# Cuadra en el VPS (erp.budly.cl) - NO subir a GitHub ni compartir',
    'POSTGRES_USER=cuadra',
    'POSTGRES_DB=cuadra',
    "POSTGRES_PASSWORD=$pgPass",
    '',
    'WEB_ORIGIN=https://erp.budly.cl',
    'NEXT_PUBLIC_API_URL=https://erp.budly.cl/api',
    '# Puertos en 127.0.0.1 del VPS (Nginx entra por aqui). Cambialos si chocan con los otros ERP',
    'API_HOST_PORT=4290',
    'WEB_HOST_PORT=3290',
    '',
    '# MISMO AUTH_SECRET de tu PC: con el se cifran las claves del SII y de los retailers',
    "AUTH_SECRET=$($envVars.AUTH_SECRET)",
    "SESSION_DAYS=$(if ($envVars.SESSION_DAYS) { $envVars.SESSION_DAYS } else { '7' })",
    'COOKIE_SECURE=true',
    "SUPERADMIN_EMAIL=$($envVars.SUPERADMIN_EMAIL)",
    "SUPERADMIN_PASSWORD=$($envVars.SUPERADMIN_PASSWORD)",
    '# Correo para el certificado HTTPS (Let''s Encrypt)',
    "CERTBOT_EMAIL=$($envVars.SUPERADMIN_EMAIL)"
  )
  [IO.File]::WriteAllText("$PWD\$prod", (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
  Write-Host "   OK $prod (AUTH_SECRET copiado de tu .env)" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Listo. El codigo va por GitHub; al VPS solo subes los datos (cambia usuario@IP por el tuyo):' -ForegroundColor Cyan
Write-Host '  git add -A; git commit -m "despliegue"; git push'
Write-Host '  ssh usuario@IP "git clone https://github.com/FelipeJS1295/cuadra.git /opt/cuadra"'
Write-Host '  scp deploy\cuadra.dump deploy\.env.production deploy\conteo-local.txt usuario@IP:/opt/cuadra/'
