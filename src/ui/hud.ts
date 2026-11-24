import { clamp, fmtTime, toKmh } from '../core/util';
import { eraAt, locoById } from '../data';
import { routeGrade, routeElev, routeTunnel, type Feature } from '../world/track';
import { weatherDescription, type Trip } from '../game/trip';
import { dateOf, fmtDate } from '../sim/weather';
import { yearNow } from '../game/state';
import { audio } from '../audio/audio';

const $ = (el: HTMLElement, r: string) => el.querySelector(`[data-r="${r}"]`) as HTMLElement;

function dial(id: string, max: number, major: number, redFrom: number, unit: string, size = 170): string {
  const cx = 85, cy = 85, R = 70;
  const pt = (a: number, r: number) => `${(cx + Math.cos((a - 90) * Math.PI / 180) * r).toFixed(1)},${(cy + Math.sin((a - 90) * Math.PI / 180) * r).toFixed(1)}`;
  let ticks = '';
  for (let v = 0; v <= max + 0.001; v += major / 2) {
    const a = -120 + 240 * v / max; const big = Math.abs(v / major - Math.round(v / major)) < 0.01;
    ticks += `<line x1="${pt(a, R).split(',')[0]}" y1="${pt(a, R).split(',')[1]}" x2="${pt(a, R - (big ? 11 : 6)).split(',')[0]}" y2="${pt(a, R - (big ? 11 : 6)).split(',')[1]}" stroke="${redFrom && v >= redFrom ? '#d0604a' : '#e8dcc0'}" stroke-width="${big ? 2 : 1}"/>`;
    if (big) { const tp = pt(a, R - 21).split(','); ticks += `<text x="${tp[0]}" y="${+tp[1] + 4}" font-size="${size > 120 ? 11 : 9}" fill="#e8dcc0" text-anchor="middle">${Math.round(v)}</text>`; }
  }
  return `<svg viewBox="0 0 170 170"><circle cx="85" cy="85" r="82" fill="#1d150e" stroke="#8a6a36" stroke-width="3"/><circle cx="85" cy="85" r="76" fill="#241a11" stroke="#3a2b1b"/>${ticks}
  <line data-r="${id}-lim" x1="85" y1="9" x2="85" y2="20" stroke="#ff4a3a" stroke-width="4" transform="rotate(-120 85 85)"/>
  <g data-r="${id}-needle" transform="rotate(-120 85 85)"><polygon points="83,90 87,90 86,18 84,18" fill="#f0c060"/></g><circle cx="85" cy="85" r="6" fill="#8a6a36"/>
  <text x="85" y="124" font-size="12" fill="#b9a98c" text-anchor="middle">${unit}</text><text data-r="${id}-txt" x="85" y="148" font-size="22" fill="#f3e7cf" text-anchor="middle" font-family="Georgia">0</text></svg>`;
}

export class DriveHud {
  root: HTMLElement; trip!: Trip; keys = new Set<string>(); onPause: () => void = () => {}; onHelp: () => void = () => {};
  private kd = (e: KeyboardEvent) => this.keyDown(e); private ku = (e: KeyboardEvent) => this.keys.delete(e.code);
  private lastRB = 0; private instr = 0; private vMax = 120; private pMax = 14; private traction = 'diesel'; private dialMax = 140;
  private dragging = new Set<string>();
  paused = false;

  constructor(root: HTMLElement) { this.root = root; }

  attach(trip: Trip) {
    this.trip = trip;
    const u = trip.units[0], d = locoById(u.defId);
    this.instr = u.upgrades.instruments ?? 0; this.traction = d.traction;
    this.vMax = d.maxSpeedKmh; this.dialMax = Math.ceil((Math.max(d.maxSpeedKmh, eraAt(yearNow(trip.g.state)).lineSpeedKmh) + 10) / 20) * 20;
    this.pMax = d.steam?.pBar ?? 14;
    const c = trip.ctl;
    c.cutoff = 0.45; c.brake = 0.6; c.throttle = 0; c.pantograph = true;
    const steam = d.traction === 'steam', electric = d.traction === 'electric', diesel = d.traction === 'diesel';
    this.root.innerHTML = `
    <div class="topbar">
      <div class="pill">➜ <b data-r="dest"></b></div>
      <div class="pill" data-r="clock"></div>
      <div class="pill" data-r="weather"></div>
      <div class="sp"></div>
      <div class="pill">⏱ <b data-r="time">0:00</b> / <span data-r="target"></span></div>
      <div class="pill">Quai : <b data-r="dist"></b></div>
      <button data-r="pausebtn">⏸ Pause</button>
    </div>
    <div class="routebook" data-r="book"><div class="dim" style="margin-bottom:3px">Livret de ligne</div><div data-r="items"></div>${this.instr >= 1 ? '<canvas data-r="prof" width="250" height="44"></canvas>' : ''}</div>
    <div class="signal-flag" data-r="flag" style="display:none"></div>
    <div class="stopbar" data-r="stopbar" style="display:none"><span data-r="stoptxt"></span><div class="track"><div class="zone" data-r="zone"></div><div class="mk" data-r="mk"></div></div></div>
    <div class="cab">
      <div class="dial">${dial('spd', this.dialMax, 20, d.maxSpeedKmh, 'km/h')}<div class="speedlim" data-r="limsign">—</div></div>
      <div class="gauges">
        ${steam ? `
        <div class="gbox mini-dial" style="width:112px;height:auto"><div class="dial" style="width:100px;height:100px;align-self:center">${dial('prs', Math.ceil(this.pMax * 1.2 / 2) * 2, 2, this.pMax * 1.02, 'bar', 100)}</div></div>
        <div class="gbox"><div class="lbl"><span>Niveau d’eau</span><span class="val" data-r="lvltxt"></span></div><div class="bar"><i data-r="lvl"></i></div>
          <div class="lbl" style="margin-top:6px"><span>Feu (couche)</span><span class="val" data-r="bedtxt"></span></div><div class="bar"><i data-r="bed"></i></div>
          <div class="lbl" style="margin-top:6px"><span>Tender</span><span class="val" data-r="coaltxt"></span></div><div class="bar thin"><i data-r="coal"></i></div><div class="bar thin" style="margin-top:3px"><i data-r="water" style="background:#6fa3d6"></i></div></div>` : ''}
        ${diesel ? `<div class="gbox"><div class="lbl"><span>Puissance</span><span class="val" data-r="pwrtxt"></span></div><div class="bar"><i data-r="pwr"></i></div>
          <div class="lbl" style="margin-top:6px"><span>Température moteur</span><span class="val" data-r="temptxt"></span></div><div class="bar"><i data-r="temp"></i></div>
          <div class="lbl" style="margin-top:6px"><span>Carburant</span><span class="val" data-r="fueltxt"></span></div><div class="bar"><i data-r="fuel"></i></div></div>` : ''}
        ${electric ? `<div class="gbox"><div class="lbl"><span>Puissance</span><span class="val" data-r="pwrtxt"></span></div><div class="bar"><i data-r="pwr"></i></div>
          <div class="lbl" style="margin-top:6px"><span>Caténaire</span><span class="val" data-r="voltxt"></span></div><div class="bar"><i data-r="vol"></i></div>
          <div class="lbl" style="margin-top:6px"><span>Température moteurs</span><span class="val" data-r="temptxt"></span></div><div class="bar"><i data-r="temp"></i></div></div>` : ''}
        <div class="gbox"><div class="lbl"><span>Frein (pression)</span><span class="val" data-r="brktxt"></span></div><div class="bar"><i data-r="brk" style="background:#d0604a"></i></div>
          ${this.instr >= 2 ? `<div class="lbl" style="margin-top:6px"><span>Température freins</span><span class="val" data-r="btemptxt"></span></div><div class="bar"><i data-r="btemp"></i></div>` : '<div class="dim small" style="margin-top:6px">Instruments : niveau ' + this.instr + '/3</div>'}
          <div class="lbl" style="margin-top:6px"><span>Sable</span><span class="val" data-r="sandtxt"></span></div><div class="bar thin"><i data-r="sand" style="background:#d8c38a"></i></div>
          <div class="lbl" style="margin-top:6px"><span>Rame</span><span class="val">${Math.round(trip.sim.totalMassT)} t · ${trip.sim.vehicles.length} véh.</span></div></div>
        <div class="gbox" style="min-width:100px"><div class="lbl"><span>Pente</span><span class="val" data-r="grade">—</span></div><div class="lbl"><span>Effort</span><span class="val" data-r="te">—</span></div><div class="lbl"><span>Statut</span></div><div data-r="status" class="small" style="max-width:130px">—</div></div>
      </div>
      <div class="levers">
        <div class="lever"><input type="range" min="0" max="100" value="0" data-r="s-thr"><span class="v" data-r="v-thr">0 %</span>${steam ? 'Régulateur' : 'Traction'}</div>
        <div class="lever"><input type="range" min="0" max="100" value="60" data-r="s-brk"><span class="v" data-r="v-brk">60 %</span>Frein</div>
        ${steam ? '<div class="lever"><input type="range" min="12" max="75" value="45" data-r="s-cut"><span class="v" data-r="v-cut">45 %</span>Inverseur</div>' : ''}
        ${!steam ? '<div class="lever"><input type="range" min="0" max="100" value="0" data-r="s-dyn"><span class="v" data-r="v-dyn">0 %</span>Frein mot.</div>' : ''}
        <div class="btns">
          ${steam ? '<button data-r="b-shovel">Pelle<kbd>G</kbd></button><button data-r="b-inj">Injecteur<kbd>I</kbd></button><button data-r="b-blow">Ventilateur<kbd>B</kbd></button>' : ''}
          ${electric ? '<button data-r="b-pan">Pantographe<kbd>P</kbd></button>' : ''}
          <button data-r="b-sand">Sablage<kbd>C</kbd></button><button data-r="b-whi">Sifflet<kbd>H</kbd></button>
          <button data-r="b-emg" class="danger">Urgence<kbd>␣</kbd></button><button data-r="b-help">Aide<kbd>F1</kbd></button>
        </div>
      </div>
    </div>
    <div class="panel-center" data-r="brk-panel" style="display:none"></div>`;
    $(this.root, 'dest').textContent = trip.g.world.cities[trip.contract.to].name;
    $(this.root, 'target').textContent = fmtTime(trip.contract.targetSec);
    this.bindUi();
    window.addEventListener('keydown', this.kd); window.addEventListener('keyup', this.ku);
  }

  detach() { window.removeEventListener('keydown', this.kd); window.removeEventListener('keyup', this.ku); this.root.innerHTML = ''; this.keys.clear(); }

  private bindUi() {
    const c = this.trip.ctl, r = this.root;
    const slider = (name: string, fn: (v: number) => void) => { const el = $(r, name) as HTMLInputElement | null; if (!el) return; el.addEventListener('input', () => fn(+el.value)); el.addEventListener('pointerdown', () => this.dragging.add(name)); window.addEventListener('pointerup', () => this.dragging.delete(name)); };
    slider('s-thr', v => { c.throttle = v / 100; if (v > 0 && c.brake > 0.05) c.brake = Math.min(c.brake, 0.05); });
    slider('s-brk', v => { c.brake = v / 100; });
    slider('s-cut', v => { c.cutoff = v / 100; });
    slider('s-dyn', v => { c.dyn = v / 100; });
    const btn = (name: string, fn: () => void) => { const el = $(r, name); if (el) el.addEventListener('click', () => { fn(); audio.ui('click'); (document.activeElement as HTMLElement)?.blur?.(); }); };
    btn('b-shovel', () => { c.shovel = !c.shovel; });
    btn('b-inj', () => { c.injector = !c.injector; }); btn('b-blow', () => { c.blower = !c.blower; });
    btn('b-pan', () => { c.pantograph = !c.pantograph; }); btn('b-sand', () => { c.sand = !c.sand; });
    const whi = $(r, 'b-whi'); whi.addEventListener('pointerdown', () => this.trip.whistle(true)); whi.addEventListener('pointerup', () => this.trip.whistle(false)); whi.addEventListener('pointerleave', () => this.trip.whistle(false));
    btn('b-emg', () => { c.emergency = !c.emergency; if (c.emergency) c.throttle = 0; else c.brake = Math.max(c.brake, 0.9); });
    btn('b-help', () => this.onHelp()); btn('pausebtn', () => this.onPause());
  }

  private keyDown(e: KeyboardEvent) {
    if (e.repeat) { if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault(); return; }
    const c = this.trip.ctl;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1'].includes(e.code)) e.preventDefault();
    audio.resume();
    this.keys.add(e.code);
    switch (e.code) {
      case 'Escape': this.onPause(); break;
      case 'F1': this.onHelp(); break;
      case 'Space': c.emergency = true; c.throttle = 0; break;
      case 'KeyI': c.injector = !c.injector; break;
      case 'KeyB': c.blower = !c.blower; break;
      case 'KeyP': c.pantograph = !c.pantograph; break;
      case 'KeyC': c.sand = !c.sand; break;
      case 'KeyM': audio.toggleMute(); break;
      case 'KeyH': this.trip.whistle(true); break;
      case 'KeyG': c.shovel = true; break;
    }
  }
  private keyUpSpecial() {
    const c = this.trip.ctl;
    if (!this.keys.has('Space') && c.emergency) { c.emergency = false; c.brake = Math.max(c.brake, 0.9); }
    if (!this.keys.has('KeyH') && this.trip.whistleHeld && !this.whistleBtn()) this.trip.whistle(false);
    if (!this.keys.has('KeyG') && c.shovel && !this.shovelBtn) c.shovel = false;
  }
  private whistleBtn() { return false; }
  private shovelBtn = false;

  /** Applique les touches maintenues (leviers progressifs). */
  applyKeys(dt: number) {
    const c = this.trip.ctl, k = this.keys, fast = k.has('ShiftLeft') || k.has('ShiftRight') ? 2.5 : 1;
    const up = (k.has('KeyW') || k.has('ArrowUp') || k.has('KeyZ')) ? 1 : 0, dn = (k.has('KeyS') || k.has('ArrowDown')) ? 1 : 0;
    if (up) { c.throttle = clamp(c.throttle + dt * 0.45 * fast, 0, 1); if (c.brake > 0.05 && !c.emergency) c.brake = Math.max(0.05, c.brake - dt * 2); }
    if (dn) c.throttle = clamp(c.throttle - dt * 0.6 * fast, 0, 1);
    if (k.has('ArrowLeft') || k.has('KeyA') || k.has('KeyQ')) { c.brake = clamp(c.brake + dt * 0.55 * fast, 0, 1); }
    if (k.has('ArrowRight') || k.has('KeyD') || k.has('KeyE')) { c.brake = clamp(c.brake - dt * 0.55 * fast, 0, 1); }
    if (k.has('KeyR')) c.cutoff = clamp(c.cutoff + dt * 0.25, 0.12, 0.75);
    if (k.has('KeyF')) c.cutoff = clamp(c.cutoff - dt * 0.25, 0.12, 0.75);
    if (k.has('KeyX')) c.dyn = clamp(c.dyn + dt * 0.6, 0, 1);
    if (k.has('KeyV')) c.dyn = clamp(c.dyn - dt * 0.6, 0, 1);
    this.keyUpSpecial();
    if (c.brake > 0.3 && c.throttle > 0 && !up) c.throttle = Math.max(0, c.throttle - dt * 2);
  }

  private bar(name: string, frac: number, txt?: string, cls = '') {
    const el = $(this.root, name); if (!el) return;
    el.style.width = `${clamp(frac, 0, 1) * 100}%`;
    const p = el.parentElement!; p.classList.remove('low', 'mid'); if (cls) p.classList.add(cls);
    if (txt !== undefined) { const t = $(this.root, name + 'txt'); if (t) t.textContent = txt; }
  }
  private setNeedle(id: string, val: number, max: number) { const n = $(this.root, id + '-needle'); if (n) n.setAttribute('transform', `rotate(${-120 + 240 * clamp(val / max, 0, 1.03)} 85 85)`); }

  update() {
    const trip = this.trip, sim = trip.sim, r = this.root, c = trip.ctl;
    const kmh = toKmh(Math.abs(sim.v));
    const lim = Math.min(trip.currentLimit(), sim.maxSpeedAllowed);
    this.setNeedle('spd', kmh, this.dialMax);
    const ln = $(r, 'spd-lim'); ln.setAttribute('transform', `rotate(${-120 + 240 * clamp(toKmh(lim) / this.dialMax, 0, 1)} 85 85)`);
    $(r, 'spd-txt').textContent = String(Math.round(kmh));
    const ls = $(r, 'limsign'); ls.textContent = String(Math.round(toKmh(lim) / 5) * 5); ls.style.borderColor = kmh > toKmh(lim) * 1.06 + 1 ? '#ff2a1a' : '#d4302c';
    const d = dateOf(trip.g.state.startYear, trip.g.state.day);
    const hr = trip.hour % 24;
    $(r, 'clock').innerHTML = `${fmtDate(d)} · <b>${String(Math.floor(hr)).padStart(2, '0')}:${String(Math.floor((hr % 1) * 60)).padStart(2, '0')}</b>`;
    $(r, 'weather').textContent = weatherDescription(trip.weather);
    const tEl = $(r, 'time'); tEl.textContent = fmtTime(trip.time); tEl.style.color = trip.time > trip.contract.targetSec * 1.25 ? '#d0604a' : '';
    const dist = trip.distToStop(); $(r, 'dist').textContent = dist > 1000 ? (dist / 1000).toFixed(1) + ' km' : Math.max(0, Math.round(dist)) + ' m';
    // leviers
    const sync = (name: string, v: number, txt: string, vname: string) => { const el = $(r, name) as HTMLInputElement | null; if (el && !this.dragging.has(name)) el.value = String(v); const t = $(r, vname); if (t) t.textContent = txt; };
    sync('s-thr', Math.round(c.throttle * 100), `${Math.round(c.throttle * 100)} %`, 'v-thr');
    sync('s-brk', Math.round(c.brake * 100), `${Math.round(c.brake * 100)} %`, 'v-brk');
    sync('s-cut', Math.round(c.cutoff * 100), `${Math.round(c.cutoff * 100)} %`, 'v-cut');
    sync('s-dyn', Math.round(c.dyn * 100), `${Math.round(c.dyn * 100)} %`, 'v-dyn');
    const tg = (name: string, on: boolean) => { const el = $(r, name); if (el) el.classList.toggle('on', on); };
    tg('b-shovel', c.shovel); tg('b-inj', c.injector); tg('b-blow', c.blower); tg('b-pan', c.pantograph); tg('b-sand', c.sand); tg('b-whi', trip.whistleHeld); tg('b-emg', c.emergency);
    // jauges selon la traction
    if (sim.steam) {
      const s = sim.steam;
      this.setNeedle('prs', s.pressure, Math.ceil(this.pMax * 1.2 / 2) * 2); $(r, 'prs-txt').textContent = s.pressure.toFixed(1);
      this.bar('lvl', s.level, `${Math.round(s.level * 100)} %`, s.level < 0.25 ? 'low' : s.level > 0.9 ? 'mid' : '');
      const opt = sim.locoDef.steam!.bedOptKg; this.bar('bed', s.bed / (opt * 1.6), `${Math.round(s.bed)} kg`, s.bed < opt * 0.45 ? 'low' : s.bed > opt * 1.4 ? 'mid' : '');
      this.bar('coal', s.coal / s.coalTotal, `${Math.round(s.coal)} kg · ${Math.round(s.water / 1000)} m³`); this.bar('water', s.water / s.waterTotal);
    }
    if (sim.diesel) { const dd = sim.diesel; this.bar('pwr', dd.pf, `${Math.round(dd.pf * 100)} %`); this.bar('temp', (dd.temp - 40) / 100, `${Math.round(dd.temp)} °C`, dd.temp > 108 ? 'low' : dd.temp > 98 ? 'mid' : ''); this.bar('fuel', dd.fuel / dd.fuelCap, `${Math.round(dd.fuel)} L`, dd.fuel / dd.fuelCap < 0.12 ? 'low' : ''); }
    if (sim.electric) { const e = sim.electric; this.bar('pwr', e.pf, `${Math.round(e.pf * 100)} %`); const vn = sim.locoDef.electric!.voltage; this.bar('vol', e.voltage / vn, e.voltage > 0 ? `${(e.voltage / 1000).toFixed(1)} kV` : (e.powered ? 'groupe aux.' : 'aucune'), e.voltage === 0 && !e.powered ? 'low' : ''); this.bar('temp', (e.temp - 20) / 120, `${Math.round(e.temp)} °C`, e.temp > 120 ? 'low' : ''); }
    this.bar('brk', sim.brakeP / 1.25, `${Math.round(sim.brakeP * 100)} %`);
    if (this.instr >= 2) this.bar('btemp', (sim.brakeTempAvg - 20) / 480, `${Math.round(sim.brakeTempAvg)} °C`, sim.brakeTempAvg > 400 ? 'low' : sim.brakeTempAvg > 250 ? 'mid' : '');
    this.bar('sand', sim.sand, `${Math.round(sim.sand * 100)} %`, sim.sand < 0.15 ? 'low' : '');
    const gr = routeGrade(trip.route, sim.s - sim.length / 3) * 100;
    $(r, 'grade').textContent = this.instr >= 1 ? `${gr >= 0 ? '+' : ''}${gr.toFixed(1)} %` : (gr > 1.2 ? 'montée' : gr < -1.2 ? 'descente' : 'plat');
    $(r, 'te').textContent = `${Math.round(sim.tractionN / 1000)} kN`;
    const st: string[] = [];
    if (sim.slipping) st.push(this.instr >= 2 ? '⚠ patinage' : 'roues qui patinent');
    if (sim.skidding) st.push('⚠ enrayage');
    if (sim.faults.couplingBroken) st.push('attelage rompu'); if (sim.faults.stalled) st.push('machine à l’arrêt');
    if (sim.faults.speedCap < 99) st.push(`limité à ${Math.round(toKmh(sim.faults.speedCap))} km/h`);
    if (sim.faults.powerMul < 1) st.push('puissance réduite');
    if (routeTunnel(trip.route, sim.s)) st.push('tunnel');
    if (sim.electric && sim.electric.voltage === 0 && sim.electric.pantoUp && !sim.electric.powered) st.push('pas de courant');
    if (kmh > toKmh(lim) * 1.06 + 1) st.push('⚠ survitesse');
    $(r, 'status').innerHTML = st.length ? st.map(s => `<div class="${s.startsWith('⚠') || s.includes('rompu') ? 'bad' : 'brass'}">${s}</div>`).join('') : '<span class="good">Normal</span>';
    // signaux en vue
    const flag = $(r, 'flag'); const red = trip.nextRedSignal();
    const distant = trip.route.features.find(f => f.kind === 'distant' && f.s > sim.s && f.s - sim.s < eraAt(yearNow(trip.g.state)).signalSight && trip.signalAspect(f) === 'yellow');
    if (red !== null && red < 1500) { flag.style.display = ''; flag.className = 'signal-flag flag-red'; flag.textContent = `Signal fermé à ${Math.round(red)} m — arrêt absolu`; }
    else if (distant) { flag.style.display = ''; flag.className = 'signal-flag flag-yellow'; flag.textContent = `Avertissement : le prochain signal est fermé (${Math.round(distant.s - sim.s)} m)`; }
    else flag.style.display = 'none';
    // barre d'arrêt
    const sb = $(r, 'stopbar');
    if (dist < 450 && dist > -60) {
      sb.style.display = ''; const span = 450;
      $(r, 'zone').style.left = `${((span - 25) / (span + 60)) * 100}%`; $(r, 'zone').style.width = `${(60 / (span + 60)) * 100}%`;
      $(r, 'mk').style.left = `${clamp((span - dist) / (span + 60), 0, 1) * 100}%`;
      const need = (sim.v * sim.v) / (2 * 0.6);
      $(r, 'stoptxt').innerHTML = `Arrêt en gare : ${Math.round(dist)} m${this.instr >= 3 ? ` · distance de freinage ≈ <b>${Math.round(need)} m</b>` : ''}`;
    } else sb.style.display = 'none';
    // livret de ligne
    this.lastRB += 1; if (this.lastRB % 6 === 0) this.updateBook();
    // panne
    const bp = $(r, 'brk-panel');
    const stopped = Math.abs(sim.v) < 0.3;
    if ((stopped && sim.hasFault() && trip.status === 'running' && (trip.distToStop() > 60 || sim.faults.stalled || sim.faults.couplingBroken || sim.faults.speedCap <= 3.01)) || trip.repairing) {
      bp.style.display = '';
      const parts = trip.g.state.parts;
      bp.innerHTML = `<div class="break-panel"><h3 style="margin-top:0">${trip.repairing ? 'Réparation en cours…' : 'Panne en ligne'}</h3>
        ${trip.repairing ? `<div class="prog"><i style="width:${trip.repairProgress * 100}%"></i></div><div class="dim small">Ne bougez pas le train.</div>` :
        `<div class="small dim" style="margin-bottom:8px">${sim.speedCapReason || (sim.faults.stalled ? 'La machine est à l’arrêt.' : sim.faults.couplingBroken ? 'Un attelage a cédé.' : 'Un défaut limite votre train.')}</div>
         <button class="primary" data-act="repair">🔧 Réparer sur place (1 pièce — ${parts} en stock)</button> <button data-act="tow" class="danger">Appeler le dépanneur</button>`}
      </div>`;
    } else if (bp.style.display !== 'none') { bp.style.display = 'none'; bp.innerHTML = ''; }
  }

  private bookSig = '';
  private updateBook() {
    const trip = this.trip, sim = trip.sim, r = trip.route;
    const sight = eraAt(yearNow(trip.g.state)).signalSight;
    const items: { d: number; txt: string; cls?: string }[] = [];
    for (const f of r.features) {
      const d = f.s - sim.s; if (d < -10 || d > 3200) continue;
      const it = this.describe(f, d, sight); if (it) items.push({ d, ...it });
    }
    // tunnels
    for (let s = Math.max(0, sim.s); s < sim.s + 3200 && s < r.length - 10; s += 20) {
      const gi = Math.round(s / 10);
      if (r.tunnel[gi] && !r.tunnel[gi - 1]) { let e = gi; while (r.tunnel[e]) e++; items.push({ d: s - sim.s, txt: `Tunnel (${(e - gi) * 10} m)` }); break; }
    }
    items.sort((a, b) => a.d - b.d);
    const html = items.slice(0, 7).map(i => `<div class="it"><span class="d">${i.d < 1000 ? Math.max(0, Math.round(i.d / 10) * 10) + ' m' : (i.d / 1000).toFixed(1) + ' km'}</span><span class="${i.cls ?? ''}">${i.txt}</span></div>`).join('');
    if (html !== this.bookSig) { this.bookSig = html; $(this.root, 'items').innerHTML = html || '<div class="dim">Voie libre</div>'; }
    const cv = $(this.root, 'prof') as HTMLCanvasElement | null;
    if (cv) {
      const x = cv.getContext('2d')!; x.clearRect(0, 0, cv.width, cv.height);
      const span = 2400, n = 60; const ys: number[] = []; let mn = 1e9, mx = -1e9;
      for (let i = 0; i <= n; i++) { const e = routeElev(r, sim.s - 200 + (span * i) / n); ys.push(e); mn = Math.min(mn, e); mx = Math.max(mx, e); }
      const rg = Math.max(8, mx - mn);
      x.fillStyle = 'rgba(134,192,108,.35)'; x.beginPath(); x.moveTo(0, cv.height);
      ys.forEach((e, i) => x.lineTo((i / n) * cv.width, cv.height - 4 - ((e - mn) / rg) * (cv.height - 10))); x.lineTo(cv.width, cv.height); x.fill();
      x.strokeStyle = '#86c06c'; x.beginPath(); ys.forEach((e, i) => { const px = (i / n) * cv.width, py = cv.height - 4 - ((e - mn) / rg) * (cv.height - 10); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
      x.fillStyle = '#e0ad4f'; x.fillRect((200 / span) * cv.width - 1, 0, 2, cv.height);
    }
  }
  private describe(f: Feature, d: number, sight: number): { txt: string; cls?: string } | null {
    const trip = this.trip;
    switch (f.kind) {
      case 'speedsign': return { txt: f.data!.warn ? `Annonce de travaux : ${f.data!.kmh} km/h` : `Limite ${f.data!.kmh} km/h`, cls: f.data!.warn ? 'brass' : '' };
      case 'signal': { if (d > sight) return { txt: 'Signal (aspect inconnu)' }; const a = trip.signalAspect(f); return { txt: a === 'red' ? 'SIGNAL FERMÉ' : 'Signal ouvert', cls: a === 'red' ? 'bad' : 'good' }; }
      case 'distant': { if (d > sight) return { txt: 'Signal d’avertissement' }; const a = trip.signalAspect(f); return { txt: a === 'yellow' ? 'Avertissement (jaune)' : 'Avertissement (vert)', cls: a === 'yellow' ? 'brass' : 'good' }; }
      case 'curvesign': return { txt: `Courbe (R ≈ ${f.data!.r} m)` };
      case 'crossing': { const cs = trip.crossings.find(x => x.f === f); const car = cs && cs.car && !cs.cleared && d < 300; return { txt: car ? 'PASSAGE À NIVEAU — véhicule engagé ! Sifflez' : 'Passage à niveau (sifflet)', cls: car ? 'bad' : '' }; }
      case 'worksite': return { txt: `Chantier : ${f.data!.kmh} km/h`, cls: 'brass' };
      case 'stopmark': return { txt: 'Quai — repère d’arrêt', cls: 'teal' };
      case 'station': return { txt: `Gare de ${trip.g.world.cities[f.data!.city as number].name} (sans arrêt)` };
      case 'neutral': return { txt: 'Zone neutre : couper la traction', cls: 'brass' };
      case 'loopstart': return { txt: 'Gare de croisement (voie d’évitement)' };
      case 'buffer': return { txt: 'Heurtoir', cls: 'bad' };
      default: return null;
    }
  }
}
