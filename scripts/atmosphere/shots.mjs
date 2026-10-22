// Screenshots and frame times for the atmosphere (docs/atmosphere.md): the same views at several times of day.
// Start the dev server first (npm run dev), then:
//
//   npm i --no-save playwright && node scripts/atmosphere/shots.mjs [http://localhost:5173/] [--gpu] [--only=name]
//
// --gpu uses a real, GPU-backed Chrome window; without it, headless Chromium (software GL, slow).
// Writes docs/images/atmosphere/<view>.jpg (not committed) and prints frame times as JSON.
import fs from 'node:fs';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const gpu = args.includes('--gpu');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
const base = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:5173/';
const out = 'docs/images/atmosphere';
fs.mkdirSync(out, { recursive: true });

// heading: compass bearing in radians the camera faces; height: km above the ground; time: UTC on the data's day.
const HOE = { lon: -4.1424, lat: 50.3647, height: 0.06 };
const VIEWS = [
  { name: 'map-noon', map: true, time: '12:00' },
  { name: 'hoe-noon', ...HOE, heading: 3.1, time: '12:00', timing: true },
  { name: 'hoe-noon-north', ...HOE, heading: 0.2, time: '12:00' },
  { name: 'hoe-sunrise', ...HOE, heading: 1.75, time: '07:05' },
  { name: 'hoe-afternoon', ...HOE, heading: 3.8, time: '15:00' },
  { name: 'hoe-sunset', ...HOE, heading: 4.4, time: '16:50' },
  { name: 'hoe-dusk', ...HOE, heading: 4.4, time: '17:30' },
  { name: 'hoe-moonlight', ...HOE, heading: 3.5, time: '22:00', timing: true },
  { name: 'hoe-moon-up', ...HOE, heading: 3.5, pitch: 0.45, time: '22:00' },
  { name: 'dartmoor-noon', lon: -3.9, lat: 50.55, heading: 3.6, height: 0.06, time: '12:00' },
  { name: 'kielder-noon', lon: -2.6, lat: 55.18, heading: 0.8, height: 0.08, time: '12:00' },
  { name: 'map-night', map: true, time: '22:00' },
].filter((v) => !only || only.includes(v.name));

const browser = await chromium.launch(
  gpu
    ? { channel: 'chrome', headless: false, args: ['--window-size=1600,980'] }
    : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
);
const page = await browser.newPage({ viewport: gpu ? { width: 1600, height: 900 } : { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.error(m.type(), m.text().slice(0, 600));
});
await page.goto(base);
await page.waitForFunction(() => window.atmosphere && window.rig, null, { timeout: 300000, polling: 500 });
if (!base.includes('detail=off')) await page.waitForFunction(() => window.detail, null, { timeout: 120000, polling: 500 }).catch(() => {});
await page.keyboard.press('h');
const mapView = await page.evaluate(() => ({ p: window.camera.position.toArray(), t: window.rig.map.target.toArray() }));

const timings = {};
for (const v of VIEWS) {
  await page.evaluate(
    ({ v, mapView }) => {
      const a = window.atmosphere;
      const day = a.time.toISOString().slice(0, 10);
      a.setTime(new Date(`${day}T${v.time}:00Z`));
      if (v.map) {
        if (window.rig.mode !== 'map') window.rig.toMap({ instant: true });
        window.camera.position.fromArray(mapView.p);
        window.rig.map.target.fromArray(mapView.t);
        window.rig.map.update();
      } else {
        const p = window.projection.toWorld(v.lon, v.lat);
        window.rig.toGround({ x: p.x, y: 0, z: p.z }, { heading: v.heading, height: v.height, instant: true });
        if (v.pitch) window.rig.ground.pitch = v.pitch;
      }
      a.snapExposure();
      window.clouds?.invalidate?.();
    },
    { v, mapView },
  );
  await page.waitForTimeout(gpu ? 5000 : 40000);
  if (v.timing) {
    timings[v.name] = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const times = [];
          let last = performance.now();
          const tick = () => {
            const now = performance.now();
            times.push(now - last);
            last = now;
            if (times.length < 120) requestAnimationFrame(tick);
            else {
              times.sort((a, b) => a - b);
              resolve({ medianMs: times[60], p90Ms: times[108] });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
  }
  const info = await page.evaluate(() => {
    const a = window.atmosphere;
    return { pre: a.preExposure, weather: a.weather, key: window.sun?.intensity };
  });
  console.error(v.name, JSON.stringify(info));
  // Read the canvas in a frame callback straight after the app's render, while the drawing buffer is intact
  // (page.screenshot times out under software GL).
  const dataUrl = await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(document.querySelector('canvas').toDataURL('image/jpeg', 0.9)))),
  );
  fs.writeFileSync(`${out}/${v.name}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
}
console.log(JSON.stringify(timings, null, 2));
await browser.close();
