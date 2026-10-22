// Close-ups of the moon through a month, to check its size and phase (docs/atmosphere.md). Dev server first, then:
//
//   node scripts/atmosphere/moon.mjs [http://localhost:5173/?detail=off] [--gpu]
//
// Writes docs/images/atmosphere/moon-<date>.jpg (not committed).
import fs from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const gpu = args.includes('--gpu');
const base = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173/?detail=off';
const out = 'docs/images/atmosphere';
fs.mkdirSync(out, { recursive: true });

// Plymouth Hoe; times when the moon is up and the sky is dark or darkening: crescent, quarter, gibbous, full, waning.
const HOE = { lon: -4.1424, lat: 50.3647 };
const TIMES = ['2026-10-14T18:00', '2026-10-18T19:00', '2026-10-22T22:00', '2026-10-26T23:00', '2026-10-31T05:00'];

const browser = await chromium.launch(
  gpu
    ? { channel: 'chrome', headless: false, args: ['--window-size=1000,640'] }
    : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
);
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(base);
await page.waitForFunction(() => window.atmosphere && window.rig, null, { timeout: 300000, polling: 500 });
await page.keyboard.press('h');

for (const time of TIMES) {
  const aim = async () =>
    page.evaluate(
      ({ time, HOE }) => {
        const a = window.atmosphere;
        a.setTime(new Date(`${time}:00Z`));
        window.clouds.enabled = false;
        a.sampler = undefined;
        a.weather = { cover: 0, base: 1e3, top: 1e3, keyLight: 1, visibility: 40 };
        if (window.rain) window.rain.enabled = false;
        const p = window.projection.toWorld(HOE.lon, HOE.lat);
        // Aim at the moon, using last frame's direction (the time was set on the same spot).
        const d = a.moonDirection;
        window.rig.toGround({ x: p.x, y: 0, z: p.z }, { heading: Math.atan2(d.x, -d.z), height: 0.06, instant: true });
        window.rig.ground.pitch = Math.asin(d.y);
        window.camera.fov = 3;
        window.camera.updateProjectionMatrix();
        a.snapExposure();
        return { altitude: (Math.asin(d.y) * 180) / Math.PI, illumination: a.sky?.moonIllumination };
      },
      { time, HOE },
    );
  await aim();
  await page.waitForTimeout(gpu ? 1500 : 8000);
  const info = await aim();
  await page.waitForTimeout(gpu ? 2500 : 12000);
  console.error(time, JSON.stringify(info));
  const dataUrl = await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.querySelector('canvas').toDataURL('image/jpeg', 0.92))))),
  );
  fs.writeFileSync(`${out}/moon-${time.slice(0, 10)}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
}
await browser.close();
