@echo off
REM Start the Ayah Sync helper (Windows). First run sets everything up.
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" in the installer, then run this again.
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo FFmpeg was not found. Install it with:  winget install Gyan.FFmpeg
  echo then close this window and run this file again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Setting up for the first time. This can take several minutes...
  python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  where nvidia-smi >nul 2>nul
  if not errorlevel 1 (
    echo NVIDIA graphics card found - installing the GPU version.
    .venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu124
  ) else (
    echo No NVIDIA graphics card found - syncing will be slow on this computer.
  )
  .venv\Scripts\pip install -r requirements.txt
)

echo.
echo Starting the helper. Leave this window open while you use the extension.
echo The first start downloads the speech models (about 3 GB).
echo.
.venv\Scripts\python server.py
pause
