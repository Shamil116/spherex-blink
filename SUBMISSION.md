# Texts for the Space Apps project page

Copy each block into the matching field of the project form (My Team → Project → Edit). Everything is in English, as the rules require. Replace the two links once the repository is public. Check every number against `README.md` if you change the tool.

Before you press "Submit for Judging" (local deadline 15 November, 16:05 Baku time):

- [ ] All members are visible on the Members tab.
- [ ] Both links open in a private browser window without a login.
- [ ] Slides: at most 7, in English, with team name, member names and the challenge name; PDF also sent to the local "Submissions" form.
- [ ] No API keys in the repository (this project uses none).
- [ ] Open the RW Aurigae and R Draconis presets once. They were built but never looked at; write what you see into the results list below, or leave the neutral sentence as it is.
- [ ] Press each of the eight preset buttons once on the published page.

---

## Project Name

SPHEREx Blink

## High-Level Project Summary

SPHEREx Blink is a public web tool that turns NASA's SPHEREx archive into a movie of any patch of sky. You type coordinates (or a name), and the page plays the SPHEREx images of that patch in time order, so anything that moves or changes brightness stands out. It answers the challenge directly: it adds the exposures of each of the six detectors into deep images, blinks and subtracts epochs, overlays Gaia and WISE sources, reads the 102-channel spectrum of any point you click, and accepts coordinates in the URL.

It runs with no server at all. The page reads only the bytes it needs straight from NASA's public SPHEREx bucket, guided by a static index of all 1.6 million SPHEREx images that we built. That makes it free to host, fast, and independent of busy archive search services.

On top of the viewer, a "Planet X stack" removes the fixed stars and adds the exposures along the path that a distant Solar-system body would follow. We validated it on real data: it finds Pluto at the right distance (36 AU measured, 35.5 AU true) and recovers the dwarf planet Eris (96 AU, magnitude 18.7), which is hard to see in any single exposure, at 13 sigma. It matters because SPHEREx returns more data than any team can inspect, and tools like this let volunteers join the search for brown dwarfs, asteroids and undiscovered planets.

## Link to Project Demo

`<public link to the 7-slide PDF>`

## Link to Final Project

`https://<your-user>.github.io/<your-repo>/` (live tool) — source code: `https://github.com/<your-user>/<your-repo>`

## Detailed Project Description

**What it does.** Enter Right Ascension and Declination, or an object name. SPHEREx Blink finds every SPHEREx exposure that covers that point (typically 250–400, in three or four visits six months apart) and shows them four ways:

- Epoch blink: one deep image per visit, for each detector or all together. Blinking the visits shows motion.
- Exposure movie: every exposure in time order, each labelled with its wavelength and metadata and linked to the original FITS file.
- Difference: one epoch minus another. Fixed stars cancel; a moving star appears as a white-black pair.
- Planet X stack: a shift-and-stack search for bodies orbiting the Sun at 20 to 2,200 AU.

Click any point to read its spectrum across 0.75–5.0 µm, built on the fly from the loaded exposures, one colour per epoch; it can be downloaded as CSV. Gaia DR3 stars are drawn at the position their proper motion gives for the date of each frame. Field of view, detectors and depth are chosen by the user, and every view has a shareable URL.

**How it works.** SPHEREx Level-2 images are 65 MB FITS files in a public Amazon S3 bucket that allows byte-range requests from browsers. Our Python script reads a 1 kB slice of each exposure's header and writes a static sky index (4,584 small JSON files for 1,628,230 images from April 2025 to October 2026). The page looks up the index, reads the 35 kB header of each matching image for its exact pointing, and downloads only the detector rows that cover the requested patch (0.4–1 MB per image). In JavaScript it applies the TAN-SIP astrometry, resamples north-up, subtracts the sky, rejects dead and hot pixels, and builds co-adds, differences and photometry. The astrometry and wavelength code is checked against astropy: positions agree to a billionth of a pixel. When a new SPHEREx release appears, re-running the index script adds it.

**Planet X stack.** For a trial distance, the page computes the path of a body from parallax (the Earth's orbit) and a circular orbit around the Sun, shifts every exposure of one visit along that path and adds them with a trimmed mean. A body at that distance sharpens into a point. A scan tries all distances and orbit tilts. An "inject test planet" button adds an artificial moving source so users can see what the search recovers.

**Results on real data.**
- Challenge test targets: Barnard's Star shows its 10.4 arcsec/yr motion as a clear pair in the difference image. Epsilon Indi B shows its motion and a brown-dwarf spectrum with methane and water bands. WISE 0855 shows a 4.4–5 µm excess of about 0.5 mJy at its predicted position, matching its known brightness. RW Aurigae and R Draconis open as presets, with each epoch's spectrum in its own colour so brightness changes between visits can be compared.
- Pluto is found at 449 sigma with a fitted distance of 36 AU (true 35.5 AU), 1 arcsec from the JPL ephemeris.
- Eris (96 AU, V = 18.7) is recovered at 13 sigma, 2 arcsec from the ephemeris.
- Injection tests in a Taurus field, where Planet Nine is most likely: a 100 µJy (AB 18.9) body at 500 AU is recovered at 10 sigma in one visit; 60 µJy is not. No signal above our 9-sigma threshold was found in that pilot field.

**Honest limits.** The published Planet Nine models that remain unexcluded are about magnitude 22, two to three magnitudes fainter than one SPHEREx visit reaches. We claim no discovery. The tool can today find a Neptune-size reflective planet out to roughly 480 AU and smaller, nearer bodies, and its reach grows with every SPHEREx survey pass.

**Benefits.** Anyone with a browser can inspect SPHEREx time-domain data: students, citizen scientists in projects like Backyard Worlds, and researchers who want a quick look before downloading files. Hosting costs nothing and needs no maintenance beyond re-running one script.

**Tools.** JavaScript (ES modules, Canvas) for the tool; Python (astropy, numpy, requests) for the index; Node.js for tests, batch searches and screenshots; GitHub Pages for hosting.

## Use of Artificial Intelligence

Yes. An AI coding assistant (Claude by Anthropic, used through Claude Code) wrote most of the code and documentation, researched how to access the data, and ran the tests, working from the team's direction. This is stated in the README and in the header of each source file. No images, video or audio were generated by AI: every figure is a screenshot of the tool displaying real NASA data. No NASA logos or branding are used.

## NASA Data

- **SPHEREx Level-2 spectral images**, data releases DR1 and QR3, from the NASA/IPAC Infrared Science Archive (IRSA), read from the public bucket `s3://nasa-irsa-spherex`. This is the core of the project: every image and spectrum in the tool comes from these files. https://irsa.ipac.caltech.edu/Missions/spherex.html (DOI 10.26131/IRSA678, 10.26131/IRSA662)
- **SPHEREx tutorial notebooks** (IRSA) for the file format and wavelength lookup. https://caltech-ipac.github.io/irsa-tutorials/spherex/
- **IRSA Moving Object Search Tool** and **JPL Horizons** for the ephemeris positions of Pluto and Eris used to validate the Planet X stack. https://irsa.ipac.caltech.edu/applications/MOST/ , https://ssd.jpl.nasa.gov/horizons/
- **CatWISE2020 catalogue** (NASA WISE/NEOWISE) for the WISE overlay. https://data.nasa.gov/dataset/catwise2020-catalog
- **WiseView** (byw.tools/wiseview), named in the challenge, as the model for the blink interface.

## Space Agency Partner Data and Other References

- **ESA Gaia DR3** (European Space Agency), through CDS VizieR, for the star overlay with proper motions. Licence CC BY-NC 3.0 IGO. https://www.cosmos.esa.int/gaia
- CDS VizieR and Sesame/SIMBAD (Strasbourg Astronomical Data Centre) for catalogue access and object-name lookup. https://cds.unistra.fr/
- Brown & Batygin 2021, "The Orbit of Planet Nine", AJ 162, 219; Brown, Holman & Batygin 2024, AJ 167, 146: Planet Nine distance and brightness.
- Bock et al. 2026, ApJ 999, 139: SPHEREx mission and sensitivity.
- Software: astropy, numpy, requests (Python); Node.js. Code written with the help of Claude (Anthropic).
- Full list with licences and required acknowledgements: `README.md`, section "Data sources and licences".
