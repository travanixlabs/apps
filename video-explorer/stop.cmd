@echo off
rem Stops a Video Explorer started by "Video Explorer.vbs" or start.cmd the
rem clean way: it writes everything it holds -- the labels, the face index,
rem the settings -- and then ends itself. Task Manager delivers no such
rem request, and skips the write.
curl -s -X POST -H "Content-Type: application/json" -d "{\"exit\":true}" http://127.0.0.1:4321/api/shutdown >nul 2>&1
if errorlevel 1 (
  echo Video Explorer is not running on port 4321.
) else (
  echo Video Explorer saved everything and stopped.
)
