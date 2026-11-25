import { newGame } from './game/state';
import { getBoard, evaluateContract, pickWagonsAuto, loadTrain } from './game/contracts';
import { acceptContract, buyLoco, selectLoco } from './game/actions';
import { Trip } from './game/trip';
import { SceneRenderer, VW, VH } from './render/scene';

const q = new URLSearchParams(location.search);
const year = Number(q.get('year') || 1905), seed = q.get('seed') || 'preview', loco = q.get('loco');
const hour = Number(q.get('hour') || 10), pos = Number(q.get('pos') || 800), speed = Number(q.get('speed') || 15);
const g = newGame({ seed, startYear: year });
g.state.money = 1e7;
if (loco) { buyLoco(g, loco); selectLoco(g, g.state.fleet.filter(u => u.kind === 'loco').pop()!.uid); }
if (q.get('day')) g.state.day = Number(q.get('day'));
let board = getBoard(g, g.state.location);
const c = board.find(x => x.kind === (q.get('kind') || 'freight')) ?? board[0];
g.state.consistUids = pickWagonsAuto(g, c);
const ev = evaluateContract(g, c, true);
acceptContract(g, c, true);
const { units, rented } = loadTrain(g, c, ev, true);
const trip = new Trip(g, c, units, rented, ev.rentCost, ev.loaded);
let startS = pos;
const at = q.get('at');
if (at) {
  const r = trip.route;
  if (at === 'tunnel') { for (let i = 0; i < r.n; i++) if (r.tunnel[i] && !r.tunnel[i - 1]) { startS = i * 10 - 150; break; } }
  if (at === 'bridge') { for (let i = 0; i < r.n; i++) if (r.bridge[i] && !r.bridge[i - 1]) { startS = i * 10 - 150; break; } }
  if (at === 'loop' && r.loops[0]) startS = r.loops[0].signalS - 260;
  if (at === 'crossing') { const f = r.features.find(x => x.kind === 'crossing'); if (f) startS = f.s - 150; }
  if (at === 'stop') startS = r.stopS - 60;
  if (at === 'station') startS = r.startFront;
  if (at === 'work') { const f = r.features.find(x => x.kind === 'worksite'); if (f) startS = f.s - 100; }
}
trip.hour = hour; trip.sim.s = startS; trip.sim.v = speed; trip.ctl.brake = 0; trip.ctl.throttle = 0.6; trip.ctl.shovel = true; trip.ctl.injector = true;
(window as any).trip = trip;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const scene = new SceneRenderer();
scene.setTrip(trip, g.world);
const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false;
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  trip.update(dt); scene.render(dt); ctx.drawImage(scene.cv, 0, 0, VW, VH);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
console.log('vehicles', trip.sim.vehicles.map(v => v.unit.defId + ':' + v.lengthM).join(','), 'len', trip.sim.length.toFixed(0), 'start', trip.route.startFront);
(window as any).bench = () => { const t0 = performance.now(); const N = 200; for (let i = 0; i < N; i++) { trip.update(1 / 60); scene.render(1 / 60); } return (performance.now() - t0) / N; };
