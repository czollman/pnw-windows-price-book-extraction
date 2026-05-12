@echo off
title PNW Price Book Pipeline
cd /d "%~dp0"

echo ============================================
echo  PNW Windows Price Book Pipeline
echo ============================================
echo.

echo [1/3] Extracting new quotes and uploading to Google Sheets...
node PNW_XMLExtractor.js --upload
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Extraction failed. See above for details.
    pause
    exit /b 1
)

echo.
echo [2/3] Refreshing pricing analysis...
node PNW_PricingAnalysis.js
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Pricing analysis failed. See above for details.
    pause
    exit /b 1
)

echo.
echo [3/3] Saving to GitHub...
git add PNW_XMLExtractor.js PNW_PricingAnalysis.js auth.js package.json .env.example .gitignore run-pipeline.bat
git diff --cached --quiet
if %errorlevel% equ 0 (
    echo No script changes to commit.
) else (
    git commit -m "Update pipeline scripts"
    git push
)

echo.
echo ============================================
echo  Done! Google Sheet and GitHub are current.
echo ============================================
pause
