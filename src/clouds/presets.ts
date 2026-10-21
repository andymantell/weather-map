// One preset per cloud type from docs/volumetric-clouds-and-rain.md. Heights in km above ground, scales in km,
// density is the peak extinction coefficient in km⁻¹ (real water cloud is tens per km), rain in mm/h.
export interface CloudPreset {
  label: string;
  base: number;
  top: number;
  /** Fraction of the sky the layer covers, 0 to 1. */
  coverage: number;
  density: number;
  /** Size of the weather cells that place individual clouds or clumps. */
  weatherScale: number;
  /** Size of one tile of the base shape noise. */
  shapeScale: number;
  /** Vertical squash of the shape noise: below 1 flattens features into sheets. */
  verticalScale: number;
  /** Stretch of the shape noise along the wind (x), for streaky cirrus. 1 is none. */
  streak: number;
  detailScale: number;
  /** How hard the detail noise eats into the edges, 0 to 1. */
  erosion: number;
  /** Fraction of the layer depth over which the base rounds off (small = flat base). */
  bottomRound: number;
  /** Fraction of the layer depth over which the top rounds off. */
  topRound: number;
  /** How far the top spreads out into an anvil, 0 to 1. */
  anvil: number;
  /** Peak rain rate under the thickest cells, mm/h. */
  rain: number;
  /** Extra absorption in raining cloud, which darkens it (Horizon's precipitation trick). */
  rainDarkening: number;
  /** Lightning flashes per minute in the lab, 0 for none. */
  lightning: number;
}

export const PRESETS: Record<string, CloudPreset> = {
  fog: {
    label: 'Fog / stratus',
    base: 0.0,
    top: 0.35,
    coverage: 0.9,
    density: 8,
    weatherScale: 60,
    shapeScale: 14,
    verticalScale: 0.15,
    streak: 1,
    detailScale: 1.2,
    erosion: 0.25,
    bottomRound: 0.02,
    topRound: 0.6,
    anvil: 0,
    rain: 0,
    rainDarkening: 0,
    lightning: 0,
  },
  stratocumulus: {
    label: 'Stratocumulus',
    base: 0.8,
    top: 1.5,
    coverage: 0.5,
    density: 25,
    weatherScale: 12,
    shapeScale: 4,
    verticalScale: 0.4,
    streak: 1,
    detailScale: 0.9,
    erosion: 0.35,
    bottomRound: 0.15,
    topRound: 0.5,
    anvil: 0,
    rain: 0,
    rainDarkening: 0,
    lightning: 0,
  },
  cumulus: {
    label: 'Fair-weather cumulus',
    base: 1.0,
    top: 2.6,
    coverage: 0.38,
    density: 40,
    weatherScale: 14,
    shapeScale: 6,
    verticalScale: 1,
    streak: 1,
    detailScale: 0.6,
    erosion: 0.45,
    bottomRound: 0.06,
    topRound: 0.9,
    anvil: 0,
    rain: 0,
    rainDarkening: 0,
    lightning: 0,
  },
  congestus: {
    label: 'Cumulus congestus',
    base: 1.0,
    top: 6.0,
    coverage: 0.42,
    density: 50,
    weatherScale: 40,
    shapeScale: 5,
    verticalScale: 1,
    streak: 1,
    detailScale: 0.9,
    erosion: 0.4,
    bottomRound: 0.04,
    topRound: 0.6,
    anvil: 0,
    rain: 4,
    rainDarkening: 0.3,
    lightning: 0,
  },
  cumulonimbus: {
    label: 'Cumulonimbus',
    base: 0.9,
    top: 11.0,
    coverage: 0.4,
    density: 60,
    weatherScale: 34,
    shapeScale: 8,
    verticalScale: 1.2,
    streak: 1,
    detailScale: 0.8,
    erosion: 0.35,
    bottomRound: 0.03,
    topRound: 0.12,
    anvil: 1,
    rain: 25,
    rainDarkening: 0.8,
    lightning: 12,
  },
  nimbostratus: {
    label: 'Nimbostratus',
    base: 0.6,
    top: 4.5,
    coverage: 0.95,
    density: 30,
    weatherScale: 50,
    shapeScale: 18,
    verticalScale: 0.35,
    streak: 1,
    detailScale: 1.5,
    erosion: 0.2,
    bottomRound: 0.05,
    topRound: 0.3,
    anvil: 0,
    rain: 3,
    rainDarkening: 0.6,
    lightning: 0,
  },
  altocumulus: {
    label: 'Altocumulus',
    base: 3.5,
    top: 4.2,
    coverage: 0.5,
    density: 25,
    weatherScale: 20,
    shapeScale: 3,
    verticalScale: 0.6,
    streak: 1,
    detailScale: 0.5,
    erosion: 0.5,
    bottomRound: 0.2,
    topRound: 0.5,
    anvil: 0,
    rain: 0,
    rainDarkening: 0,
    lightning: 0,
  },
  cirrus: {
    label: 'Cirrus',
    base: 8.0,
    top: 9.5,
    coverage: 0.45,
    density: 0.6,
    weatherScale: 40,
    shapeScale: 20,
    verticalScale: 0.08,
    streak: 8,
    detailScale: 1.5,
    erosion: 0.8,
    bottomRound: 0.3,
    topRound: 0.5,
    anvil: 0,
    rain: 0,
    rainDarkening: 0,
    lightning: 0,
  },
};
