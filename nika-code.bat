@echo off
setlocal

set "NIKA_CODE_ROOT=%~dp0"
set "PATH=%NIKA_CODE_ROOT%.build\node-runtime\node-v24.18.0-win-x64;%PATH%"

call "%NIKA_CODE_ROOT%scripts\code.bat" %*

endlocal
