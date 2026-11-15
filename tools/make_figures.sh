#!/usr/bin/env bash
# Regenerate the screenshots in figures/ from the running tool (needs: python -m http.server 8765 --directory docs).
# Usage: bash tools/make_figures.sh [base-url]
B="${1:-http://127.0.0.1:8765}"
cd "$(dirname "$0")/.." || exit 1
mkdir -p figures
click() { echo "document.querySelector('[data-view=$1]').click(); 1"; }
scan="document.getElementById('status').textContent.includes('loaded') && (window.__s || (window.__s = (document.getElementById('scanBtn').click(), 1))) && document.getElementById('pxinfo').textContent.includes('Scan:')"
inject="document.getElementById('status').textContent.includes('loaded') && (window.__s || (window.__s = (document.getElementById('inject').click(), document.getElementById('scanBtn').click(), 1))) && document.getElementById('pxinfo').textContent.includes('Scan:')"

node tools/shot.mjs "$B/?name=Barnard%27s%20Star"     figures/1_barnard_star_difference.png --do "$(click diff)"
node tools/shot.mjs "$B/?name=Epsilon%20Indi%20B"     figures/2_epsilon_indi_b_spectrum.png
node tools/shot.mjs "$B/?name=WISE%200855"            figures/3_wise0855_detector6.png --do "document.getElementById('pos').value = 3; document.getElementById('pos').dispatchEvent(new Event('input')); 1"
node tools/shot.mjs "$B/?name=RW%20Aurigae"           figures/4_rw_aurigae.png
node tools/shot.mjs "$B/?name=R%20Draconis"           figures/5_r_draconis.png
node tools/shot.mjs "$B/?name=Pluto%20(Apr%202026)"   figures/6_pluto_movie.png --do "document.getElementById('pos').value = 150; document.getElementById('pos').dispatchEvent(new Event('input')); 1"
node tools/shot.mjs "$B/?name=Eris%20(Jul%202025)"    figures/7_eris_planet_x_stack.png --wait "$scan" --timeout 400
node tools/shot.mjs "$B/?name=Planet%209%20zone"      figures/8_planet9_zone_injection.png --wait "$inject" --timeout 600
