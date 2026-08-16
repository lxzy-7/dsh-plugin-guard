@echo off
rem rollback.cmd - one-click rollback for DeepSeek Harness (double-click friendly).
rem
rem Restores the last "good" snapshot of every profile (package.json, pnpm
rem lockfile, pnpm-workspace.yaml, cordis.patch.yml), then runs
rem `pnpm install --frozen-lockfile`. Safe to run at any time, even when the
rem app cannot start. The rollback itself is reversible: a pre-rollback
rem snapshot is saved before anything is overwritten.
rem
rem Where to find it after installing dsh-plugin-guard:
rem   $DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-guard/scripts/rollback.cmd
rem Right-click > Create shortcut, or copy the file anywhere and double-click it.
rem
rem It locates DSH_HOME in this order:
rem   1) the DSH_HOME environment variable (set by your launcher), or
rem   2) the harness home derived from this file's own location, or
rem   3) the guard CLI's default (~/.dsh).

setlocal

rem 1) Derive DSH_HOME from this script's location when the env doesn't set it:
rem    <scriptdir>/..\..\..\..\..  =  $DSH_HOME/profiles/<profile>/node_modules/dsh-plugin-guard/scripts
if "%DSH_HOME%"=="" (
  if exist "%~dp0..\..\..\..\..\profiles" set "DSH_HOME=%~dp0..\..\..\..\.."
)

rem 2) Locate the guard CLI shipped inside the installed package.
set "CLI="
if defined DSH_HOME (
  if exist "%DSH_HOME%\profiles\web\node_modules\dsh-plugin-guard\scripts\guard-cli.js" set "CLI=%DSH_HOME%\profiles\web\node_modules\dsh-plugin-guard\scripts\guard-cli.js"
)
if not defined CLI if exist "%~dp0guard-cli.js" set "CLI=%~dp0guard-cli.js"

echo.
echo ==============================================
echo  DeepSeek Harness - one-click plugin rollback
echo ==============================================
echo.

set "RC=1"
if defined CLI (
  node "%CLI%" rollback --good
  set "RC=%ERRORLEVEL%"
) else (
  echo guard CLI not found.
  echo Install dsh-plugin-guard first, or set DSH_HOME to your harness home.
)

echo.
if "%RC%"=="0" (
  echo Done. If the app is currently running, restart it now.
  echo (The rollback itself is reversible: a pre-rollback snapshot was saved.)
) else (
  echo Rollback reported a problem - check the output above.
)
echo.
pause
endlocal & exit /b %RC%
