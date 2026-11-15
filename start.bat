@echo off
setlocal
pushd "%~dp0" || exit /b 1

node -e "process.exit(process.versions.node.split('.')[0] === '26' ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto fallback
if exist "node_modules\express\package.json" goto start
call npm.cmd ci --omit=dev
if errorlevel 1 goto done

:start
node index.js
goto done

:fallback
where npm.cmd >nul 2>&1
if errorlevel 1 goto missing_node
echo Node.js 26 is not on PATH. Starting with Node.js 26 via npm...
if exist "node_modules\express\package.json" goto start_fallback
call npm.cmd exec --yes --package=node@26 --call "npm ci --omit=dev"
if errorlevel 1 goto done

:start_fallback
call npm.cmd exec --yes --package=node@26 -- node index.js
goto done

:missing_node
echo Install Node.js 26 with npm and add it to PATH. 1>&2
popd
exit /b 1

:done
set "result=%errorlevel%"
popd
exit /b %result%
