// SPHEREx Blink - preset targets (used by the page and by tools/make_packs.mjs).
// `pack` names a pre-downloaded copy of the cutouts in docs/packs/ so the preset opens instantly.
// Test targets named in the challenge, plus two known distant Solar-system bodies used to validate the Planet X stack.
// Coordinates of fast-moving stars are for 2026.0; `pm` = [pmRA*cos(dec), pmDec] in mas/yr with the epoch of ra/dec.
export const PRESETS = [
  { name: "Barnard's Star", pack: 'barnard', ra: 269.4463, dec: 4.7682, fov: 4, pm: [-801.55, 10362.39, 2026.0], note: 'fastest star in the sky: 10.4 arcsec per year' },
  { name: 'Epsilon Indi B', pack: 'eps-indi-b', ra: 331.0961, dec: -56.8010, fov: 4, pm: [3967, -2536, 2026.0], note: 'pair of brown dwarfs, 4.7 arcsec per year' },
  { name: 'WISE 0855', pack: 'wise0855', ra: 133.795129, dec: -7.245147, fov: 6, pm: [-8118, 680, 2010.5], view: 'epochs', group: 6,
    note: 'coldest known brown dwarf, 8.1 arcsec per year; the orange ring is its predicted position; look in detector 6' },
  { name: 'RW Aurigae', pack: 'rw-aur', ra: 76.9564, dec: 30.4014, fov: 4, note: 'young variable star' },
  { name: 'R Draconis', pack: 'r-dra', ra: 248.1676, dec: 66.7550, fov: 4, note: 'Mira variable; very bright, so its core saturates' },
  { name: 'Pluto (Apr 2026)', pack: 'pluto', ra: 308.5364, dec: -22.9153, fov: 6, view: 'frames', group: 1, px: [35.5, 17], note: 'Pluto crosses this field during one SPHEREx visit' },
  { name: 'Planet 9 zone', pack: 'p9-taurus', ra: 60, dec: 20, fov: 10, view: 'px', px: [500, 0], note: 'a patch of Taurus, where Planet Nine is most likely to be; press "Inject test planet" to see what the search can recover' },
  { name: 'Eris (Jul 2025)', pack: 'eris', ra: 27.3707, dec: -0.1178, fov: 4, view: 'px', px: [95.6, 0], note: 'dwarf planet at 96 AU, V = 18.7: too faint to see well in one exposure' },
];
