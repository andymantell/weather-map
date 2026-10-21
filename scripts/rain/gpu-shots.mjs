// Screenshots, animation frames and frame times for the animated rain (docs/animated-rain.md), taken in a real,
// GPU-backed Chrome window. Start the dev server first (npm run dev), then:
//
//   npm i --no-save playwright && node scripts/rain/gpu-shots.mjs [http://localhost:5173/]
//
// Writes docs/images/animated-rain/<view>.jpg, frames for the animations to docs/images/animated-rain/frames/,
// and prints frame times as JSON.
import fs from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = 'docs/images/animated-rain';
fs.mkdirSync(`${out}/frames`, { recursive: true });

// World km: x east, z south. map views give camera and target; ground views a point, heading and height (km).
const VIEWS = [
  { name: 'overview', map: [-60, 420, 775, 0, 0, 155], time: true },
  { name: 'south-west-100km', map: [-110, 45, 215, -36, 0, 112] },
  { name: 'heavy-2km', map: [-228, 2.0, 552, -228, 0.3, 543], frames: 12, time: true },
  { name: 'heavy-ground', ground: [-228, 546, 0.3, 0.05], frames: 12, time: true },
  { name: 'moderate-ground', ground: [166, 402, 0.3, 0.05], frames: 12 },
  { name: 'drizzle-ground', ground: [186, 430, 0.3, 0.05], frames: 12 },
  { name: 'heavy-shafts-20km', map: [-250, 4, 590, -228, 1.5, 546] },
];

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1600,980'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(url);
await page.waitForFunction(() => window.rig && window.rain && window.clouds, null, { timeout: 300000, polling: 500 });
await page.keyboard.press('h');
await page.waitForTimeout(3000);

const frameTimes = () =>
  page.evaluate(
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

const timings = {};
for (const v of VIEWS) {
  await page.evaluate((v) => {
    const { rig, camera, clouds } = window;
    if (v.map) {
      if (rig.mode !== 'map') rig.toMap({ instant: true });
      const [cx, cy, cz, tx, ty, tz] = v.map;
      rig.map.target.set(tx, ty, tz);
      camera.position.set(cx, cy, cz);
      rig.map.update(0.016);
    } else {
      const [x, z, heading, height] = v.ground;
      rig.toGround({ x, y: 0, z }, { heading, height, instant: true });
    }
    clouds.invalidate?.();
  }, v);
  // Let the clouds and near terrain settle.
  await page.waitForTimeout(6000);
  if (v.time) {
    const on = await frameTimes();
    await page.evaluate(() => (window.rain.enabled = false));
    const off = await frameTimes();
    await page.evaluate(() => (window.rain.enabled = true));
    timings[v.name] = { rainOn: on, rainOff: off };
  }
  await page.screenshot({ path: `${out}/${v.name}.jpg`, quality: 88 });
  for (let i = 0; i < (v.frames ?? 0); i++) {
    await page.screenshot({ path: `${out}/frames/${v.name}-${String(i).padStart(2, '0')}.jpg`, quality: 85 });
  }
  console.error('saved', v.name);
}
console.log(
  JSON.stringify(
    {
      gpu: await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
      }),
      timings,
    },
    null,
    2,
  ),
);
await browser.close();
