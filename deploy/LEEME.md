# Subir Cuadra al VPS (erp.budly.cl) sin perder datos

Todo lo de Cuadra vive en la base de datos: empresas, usuarios, ventas, liquidaciones, claves del SII y de los retailers. Por eso basta con llevar un respaldo de tu base local y restaurarlo en el VPS.

> **Importante:** el `AUTH_SECRET` del VPS tiene que ser el mismo de tu PC, porque con él se cifran las claves del SII y de los retailers. El paso 1 lo copia solo.

## 0. DNS (una sola vez)
En el panel donde administras **budly.cl**, crea un registro **A** con nombre `erp` que apunte a la IP del VPS (la misma IP que usan los ERP de Jamaroff y Jerk). Es necesario para que funcione el HTTPS.

## 1. En tu PC (PowerShell, en la carpeta `cuadra`, con Docker Desktop abierto)
```powershell
powershell -ExecutionPolicy Bypass -File deploy\1-preparar-en-mi-pc.ps1
git add -A
git commit -m "despliegue"
git push
```
El script crea en `deploy\` estos archivos, que **no** se suben a GitHub (están en `.gitignore`):
- `cuadra.dump`: el respaldo de tu base.
- `.env.production`: la configuración del VPS, con tu mismo `AUTH_SECRET`.
- `conteo-local.txt`: el número de empresas, usuarios y ventas, para comparar después.

El código viaja por GitHub. **No borres nada de tu PC hasta confirmar que el VPS quedó bien.**

## 2. En el VPS: clonar y subir los datos
```bash
ssh usuario@IP
sudo git clone https://github.com/FelipeJS1295/cuadra.git /opt/cuadra
```
Si el repo es privado, git te pide usuario y contraseña. Como contraseña usa un *token* de GitHub: Settings → Developer settings → Personal access tokens, con permiso de lectura sobre el repo.

Desde tu PC, sube los datos a la carpeta clonada:
```powershell
scp deploy\cuadra.dump deploy\.env.production deploy\conteo-local.txt usuario@IP:/opt/cuadra/
```
Si `scp` no tiene permiso para escribir en `/opt/cuadra`, súbelos a tu carpeta de usuario (`usuario@IP:~/`) y muévelos en el VPS con `sudo mv ~/cuadra.dump ~/.env.production ~/conteo-local.txt /opt/cuadra/`.

## 3. En el VPS: instalar
```bash
cd /opt/cuadra
sudo bash deploy/2-instalar-en-vps.sh
```
El instalador hace lo siguiente:
- Levanta Postgres en Docker.
- Restaura tus datos, solo si la base está vacía.
- Compila y levanta la API y la web.
- Configura Nginx para `erp.budly.cl` y activa el HTTPS con certbot.
- Programa un respaldo diario a las 3:30 AM, que guarda 14 días en `deploy/respaldos/`.

Al final muestra el número de empresas, usuarios y ventas del VPS al lado de los de tu PC. Tienen que coincidir.

Si dice que un puerto está ocupado (por ejemplo, porque lo usa uno de los otros ERP), cambia `API_HOST_PORT` o `WEB_HOST_PORT` en `/opt/cuadra/.env` y vuelve a correrlo.

## Después: subir cambios nuevos
En tu PC:
```powershell
git push
```
En el VPS:
```bash
cd /opt/cuadra && sudo git pull && sudo bash deploy/2-instalar-en-vps.sh
```
Si la base ya tiene datos, el instalador **nunca** la pisa. Las migraciones nuevas se aplican solas al partir la API.

> Desde que empieces a usar el VPS, los datos buenos son los del VPS, no los de tu PC.

## Comandos útiles (en /opt/cuadra)
```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env ps          # estado
docker compose -f deploy/docker-compose.prod.yml --env-file .env logs -f api # logs de la API
sudo bash deploy/respaldar-vps.sh                                            # respaldo manual
```
