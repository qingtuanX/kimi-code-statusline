@echo off
setlocal
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0statusline.js"
