@echo off
setlocal
chcp 65001 >nul
title Train Entrain
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)"
if errorlevel 1 goto oldnode

if not exist "node_modules\electron" (
  echo Installation des dependances ^(premiere fois seulement^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto fail
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Telechargement d'Electron ^(les scripts d'installation de npm peuvent etre bloques^)...
  node node_modules\electron\install.js
  if errorlevel 1 goto fail
)

echo Demarrage de Train Entrain...
call npm start
if errorlevel 1 goto fail
exit /b 0

:nonode
echo Node.js est introuvable. Installez la version LTS depuis https://nodejs.org/ puis relancez Lancer.bat.
start https://nodejs.org/
pause
exit /b 1

:oldnode
echo Node.js 18 ou plus recent est requis. Mettez a jour depuis https://nodejs.org/.
pause
exit /b 1

:fail
echo.
echo Une erreur est survenue. Verifiez votre connexion internet puis relancez Lancer.bat.
pause
exit /b 1
