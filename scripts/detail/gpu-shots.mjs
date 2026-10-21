// Screenshots and frame times for the detailed terrain (docs/terrain-detail.md), taken in a real,
// GPU-backed Chrome window. Start the dev server first (npm run dev), then:
//
//   npm i --no-save playwright && node scripts/detail/gpu-shots.mjs [http://localhost:5173/]
//
// Writes docs/images/terrain-detail/<view>.jpg and prints frame times as JSON.
import fs from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = 'docs/images/terrain-detail';
fs.mkdirSync(out, { recursive: true });

// heading: compass bearing in radians the camera faces; height: km above the ground.
const VIEWS = [
  { name: 'plymouth-hoe', lon: -4.1424, lat: 50.3647, heading: 0.2, height: 0.06, time: true },
  { name: 'plymouth-sutton-harbour', lon: -4.135, lat: 50.372, heading: 2.5, height: 0.05 },
  { name: 'plymouth-drone', lon: -4.15, lat: 50.36, heading: 0.3, height: 0.4 },
  { name: 'devon-fields', lon: -4.03, lat: 50.36, heading: 4.0, height: 0.03 },
  { name: 'devon-fields-drone', lon: -4.03, lat: 50.355, heading: 4.0, height: 0.25 },
  { name: 'plymouth-3km', lon: -4.14, lat: 50.33, heading: 0, height: 3 },
  { name: 'kielder-forest', lon: -2.6, lat: 55.18, heading: 0.8, height: 0.08, time: true },
  { name: 'kielder-walls', lon: -2.48, lat: 55.3, heading: 3.0, height: 0.06 },
  { name: 'kielder-water', lon: -2.56, lat: 55.21, heading: 3.6, height: 0.6 },
  { name: 'dartmoor-coarse', lon: -3.9, lat: 50.55, heading: 3.6, height: 0.06 },
];

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1600,980'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.error(m.type(), m.text().slice(0, 300), m.location().url ?? '');
});
await page.goto(url);
await page.waitForFunction(() => window.detail, null, { timeout: 300000, polling: 500 });
await page.keyboard.press('h');
await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/map-overview.jpg`, quality: 85 });

const timings = {};
for (const v of VIEWS) {
  await page.evaluate((v) => {
    const p = window.projection.toWorld(v.lon, v.lat);
    window.rig.toGround({ x: p.x, y: 0, z: p.z }, { heading: v.heading, height: v.height, instant: true });
    window.clouds?.invalidate?.();
  }, v);
  // Let near trees, footprints and cloud history settle.
  await page.waitForTimeout(6000);
  if (v.time) {
    timings[v.name] = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const times = [];
          let last = performance.now();
          const tick = (t) => {
            times.push(t - last);
            last = t;
            if (times.length < 300) requestAnimationFrame(tick);
            else {
              times.sort((a, b) => a - b);
              const mean = times.reduce((a, b) => a + b, 0) / times.length;
              resolve({ meanMs: +mean.toFixed(1), medianMs: +times[150].toFixed(1), p95Ms: +times[285].toFixed(1) });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
  }
  await page.screenshot({ path: `${out}/${v.name}.jpg`, quality: 85 });
  console.error('saved', v.name);
}
console.log(JSON.stringify({ gpu: await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
}), timings }, null, 2));
await browser.close();
