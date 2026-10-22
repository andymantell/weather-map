// Screenshots of the night sky (docs/night-sky.md): the catalogue stars and planets over Plymouth Hoe with the
// clouds turned off. Start the dev server first (npm run dev), then:
//
//   npm i --no-save playwright && node scripts/stars/shots.mjs [http://localhost:5173/?detail=off] [--gpu] [--only=name]
//
// --gpu uses a real, GPU-backed Chrome window; without it, headless Chromium (software GL, slow).
// Writes docs/images/stars/<view>.jpg (not committed).
import fs from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const gpu = args.includes('--gpu');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const base = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173/?detail=off';
const out = 'docs/images/stars';
fs.mkdirSync(out, { recursive: true });

// heading: compass bearing in radians; pitch: radians above the horizon; time: UTC; fov: degrees.
const HOE = { lon: -4.1424, lat: 50.3647, height: 0.06 };
const VIEWS = [
  { name: 'south-saturn-moon', ...HOE, heading: Math.PI, pitch: 0.45, time: '2026-10-22T22:00' },
  { name: 'north-plough', ...HOE, heading: 0.1, pitch: 0.35, time: '2026-10-22T22:00' },
  { name: 'orion-rising', ...HOE, heading: 2.2, pitch: 0.4, time: '2026-10-23T00:30' },
  { name: 'pleiades-zoom', ...HOE, heading: 2.41, pitch: 1.02, time: '2026-10-23T00:30', fov: 12 },
  { name: 'milkyway-cygnus', ...HOE, heading: 3.1, pitch: 1.1, time: '2026-09-10T22:00', fov: 75 },
  { name: 'milkyway-sagittarius', ...HOE, heading: 3.4, pitch: 0.3, time: '2026-08-12T22:00', fov: 60 },
  { name: 'moonless-overhead', ...HOE, heading: 3.0, pitch: 1.2, time: '2026-11-10T02:00', fov: 75 },
].filter((v) => !only || only.includes(v.name));

const browser = await chromium.launch(
  gpu
    ? { channel: 'chrome', headless: false, args: ['--window-size=1600,980'] }
    : { executablePath: process.env.CHROMIUM_PATH, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
);
const page = await browser.newPage({ viewport: gpu ? { width: 1600, height: 900 } : { width: 960, height: 540 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
page.on('console', (m) => console.error(m.type(), m.text().slice(0, 600)));
await page.goto(base);
await page.waitForFunction(() => window.atmosphere && window.rig, null, { timeout: 300000, polling: 500 });
await page.keyboard.press('h');

// The first view twice: the exposure only settles once the app has finished starting up.
for (const [k, v] of [VIEWS[0], ...VIEWS].entries()) {
  await page.evaluate((v) => {
    const a = window.atmosphere;
    a.setTime(new Date(`${v.time}:00Z`));
    // A clear night: no cloud layer, and the atmosphere told the sky overhead is clear too.
    window.clouds.enabled = false;
    a.sampler = undefined;
    a.weather = { cover: 0, base: 1e3, top: 1e3, keyLight: 1, visibility: 40 };
    if (window.rain) window.rain.enabled = false;
    const p = window.projection.toWorld(v.lon, v.lat);
    window.rig.toGround({ x: p.x, y: 0, z: p.z }, { heading: v.heading, height: v.height, instant: true });
    window.rig.ground.pitch = v.pitch;
    window.camera.fov = v.fov ?? 60;
    window.camera.updateProjectionMatrix();
    a.snapExposure();
  }, v);
  // Once more after the sky irradiance has been read back, which the exposure depends on.
  await page.waitForTimeout(gpu ? 2000 : 10000);
  await page.evaluate(() => window.atmosphere.snapExposure());
  await page.waitForTimeout(gpu ? 3000 : 12000);
  if (k === 0) continue;
  const info = await page.evaluate(() => ({ pre: window.atmosphere.preExposure, weather: window.atmosphere.weather }));
  console.error(v.name, JSON.stringify(info));
  const dataUrl = await page.evaluate(
    (fov) =>
      new Promise((resolve) =>
        requestAnimationFrame(() => {
          window.camera.fov = fov;
          window.camera.updateProjectionMatrix();
          requestAnimationFrame(() => resolve(document.querySelector('canvas').toDataURL('image/jpeg', 0.92)));
        }),
      ),
    v.fov ?? 60,
  );
  fs.writeFileSync(`${out}/${v.name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.error('wrote', v.name);
}
await browser.close();
