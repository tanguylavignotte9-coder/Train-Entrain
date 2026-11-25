import { clamp, fmtMoney } from './core/util';
import { ERAS, eraAt, locoById } from './data';
import { startGame } from './game/contracts';
import { newGame, advanceSeconds, yearNow, worldFor, type Game } from './game/state';
import { evaluateContract, loadTrain, getBoard, pickWagonsAuto } from './game/contracts';
import { Trip } from './game/trip';
import { settleTrip, type Settlement } from './game/settle';
import { addLedger } from './game/state';
import { SceneRenderer, VW, VH } from './render/scene';
import { loadAssetOverrides } from './render/sprites';
import { Hub, esc, type AppApi } from './ui/hub';
import { DriveHud } from './ui/hud';
import { audio } from './audio/audio';
import { saveGame, loadGame, listSaves } from './game/save';
import { fmtDate, dateOf } from './sim/weather';
import { yearOf } from './economy/economy';

type Mode = 'title' | 'hub' | 'drive' | 'result';
const canvas = document.getElementById('game') as HTMLCanvasElement;
const screenEl = document.getElementById('screen') as HTMLElement;
const hudEl = document.getElementById('hud') as HTMLElement;
const toastsEl = document.getElementById('toasts') as HTMLElement;
const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false;
canvas.width = VW; canvas.height = VH;

function layout() {
  // la scène remplit la fenêtre en conservant le rapport 16:9 (mise à l'échelle fluide, pixels nets)
  const k = Math.min(innerWidth / VW, innerHeight / VH);
  canvas.style.width = `${VW * k}px`; canvas.style.height = `${VH * k}px`;
}
addEventListener('resize', layout); layout();

class App implements AppApi {
  game: Game | null = null; mode: Mode = 'title';
  hub = new Hub(screenEl, this); hud = new DriveHud(hudEl);
  scene = new SceneRenderer(); ambient: Trip | null = null; trip: Trip | null = null;
  lastToastId = 0; last = performance.now(); paused = false; resultTimer = 0; titleGame: Game | null = null; autoT = 0;
  settlement: Settlement | null = null; helpOpen = false;

  constructor() {
    this.hud.onPause = () => this.togglePause(); this.hud.onHelp = () => this.showHelp();
    hudEl.addEventListener('click', e => { const a = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null; if (!a || !this.trip) return; if (a.dataset.act === 'repair') { const m = this.trip.startFieldRepair(); if (m) this.toast(m, 'bad'); } if (a.dataset.act === 'tow') { this.trip.callTow(); } });
    addEventListener('pointerdown', () => audio.resume(), { once: false });
    addEventListener('keydown', e => { if (e.code === 'F11') { void document.documentElement.requestFullscreen?.().catch(() => {}); } });
    this.showTitle();
    requestAnimationFrame(t => this.frame(t));
  }

  // ------------------------------------------------------------ AppApi
  toast(text: string, kind: 'info' | 'warn' | 'bad' | 'good' = 'info') {
    const d = document.createElement('div'); d.className = `toast ${kind === 'info' ? '' : kind}`; d.textContent = text; toastsEl.appendChild(d);
    while (toastsEl.children.length > 5) toastsEl.firstElementChild!.remove();
    setTimeout(() => d.remove(), kind === 'bad' ? 7000 : 5000);
    if (kind === 'bad') audio.ui('alert');
  }
  applySettings() { const s = this.game?.state.settings; if (s) { audio.setVolume(s.volume); audio.setMusic(s.music); } }
  async saveSlot(slot: string) { if (!this.game) return; await saveGame(this.game, slot); this.toast(`Partie sauvegardée (emplacement ${slot}).`, 'good'); audio.ui('ok'); }
  async loadSlot(slot: string) {
    try { const g = await loadGame(slot); if (!g) { this.toast('Emplacement vide.', 'bad'); return; } this.beginGame(g); this.toast('Partie chargée.', 'good'); }
    catch (e) { this.toast('Échec du chargement : ' + (e as Error).message, 'bad'); }
  }
  toTitle() { this.stopTrip(); this.game = null; this.showTitle(); }

  // ------------------------------------------------------------ écrans
  showTitle() {
    this.mode = 'title'; this.hub.hide(); this.hud.detach(); audio.stopCab(); this.helpOpen = false;
    this.makeTitleScene();
    void listSaves().then(saves => {
      if (this.mode !== 'title') return;
      screenEl.innerHTML = `<div class="title"><h1>Train Entrain</h1><div class="sub">Conduisez. Entretenez. Bâtissez votre compagnie, d’une époque à l’autre.</div>
        <div class="menu"><button class="primary" data-a="new">Nouvelle partie</button><button data-a="continue" ${saves.length ? '' : 'disabled'}>Continuer${saves[0] ? ` <span class="dim small">(${esc(saves[0].company)}, ${saves[0].year})</span>` : ''}</button><button data-a="load" ${saves.length ? '' : 'disabled'}>Charger une partie</button><button data-a="help">Comment jouer</button><button data-a="mute">Son : activé/coupé</button></div>
        <div class="dim small" style="margin-top:22px">Simulation ferroviaire cosy mais exigeante · pixel art HD procédural · du début du XXᵉ siècle à aujourd’hui</div></div>`;
      screenEl.querySelector('.title')!.addEventListener('click', ev => this.titleClick(ev, saves));
    });
  }
  private titleClick(ev: Event, saves: Awaited<ReturnType<typeof listSaves>>) {
    const b = (ev.target as HTMLElement).closest('[data-a]') as HTMLElement | null; if (!b) return; audio.resume(); audio.ui('click');
    switch (b.dataset.a) {
      case 'new': this.showNewGame(); break;
      case 'continue': void this.loadSlot(saves[0].slot); break;
      case 'load': screenEl.innerHTML = `<div class="modal"><div class="card" style="min-width:520px"><h2>Charger une partie</h2><div class="list">${saves.map(s => `<div class="row" data-slot="${s.slot}"><div class="grow"><div class="t">${s.slot === 'auto' ? 'Sauvegarde automatique' : 'Emplacement ' + s.slot} — ${esc(s.company)}</div><div class="s">année ${s.year} · ${fmtMoney(s.money)} · ${new Date(s.savedAt).toLocaleString('fr-FR')}</div></div></div>`).join('')}</div><div style="margin-top:12px"><button data-back>Retour</button></div></div></div>`;
        screenEl.querySelector('.modal')!.addEventListener('click', e2 => { const r = (e2.target as HTMLElement).closest('[data-slot]') as HTMLElement | null; if (r) void this.loadSlot(r.dataset.slot!); if ((e2.target as HTMLElement).closest('[data-back]')) this.showTitle(); }); break;
      case 'help': this.showHelp(true); break;
      case 'mute': this.toast(audio.toggleMute() ? 'Son coupé' : 'Son activé'); break;
    }
  }
  showNewGame() {
    const yr = 1905;
    screenEl.innerHTML = `<div class="modal"><div class="card" style="width:560px"><h2>Nouvelle compagnie</h2>
      <div class="form-row"><label>Nom de la compagnie</label><input id="ng-name" value="Compagnie des Chemins de Fer" maxlength="40"></div>
      <div class="form-row"><label>Graine du monde</label><input id="ng-seed" placeholder="(vide = aléatoire)"></div>
      <div class="form-row"><label>Année de départ</label><input type="range" id="ng-year" min="1905" max="2020" value="${yr}"><b id="ng-yv" style="width:50px">${yr}</b></div>
      <div class="small dim" id="ng-era" style="margin:4px 0 10px"></div>
      <div class="small dim">Réalisme complet, un seul niveau : pas de mode facile, pas d’aides. La carte est générée à partir de la graine : la même graine redonne le même pays.</div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="primary" id="ng-go">Commencer</button><button id="ng-back">Retour</button></div></div></div>`;
    const yv = screenEl.querySelector('#ng-yv') as HTMLElement, yin = screenEl.querySelector('#ng-year') as HTMLInputElement, era = screenEl.querySelector('#ng-era') as HTMLElement;
    const upd = () => { yv.textContent = yin.value; const e = eraAt(+yin.value); era.innerHTML = `<b class="brass">${e.name}</b> — ${esc(e.blurb)}`; }; yin.oninput = upd; upd();
    (screenEl.querySelector('#ng-back') as HTMLElement).onclick = () => this.showTitle();
    (screenEl.querySelector('#ng-go') as HTMLElement).onclick = () => {
      audio.resume(); audio.ui('ok');
      const g = startGame({ company: (screenEl.querySelector('#ng-name') as HTMLInputElement).value, seed: (screenEl.querySelector('#ng-seed') as HTMLInputElement).value, startYear: +yin.value });
      this.beginGame(g);
    };
  }
  beginGame(g: Game) {
    this.game = g; this.mode = 'hub'; this.applySettings(); this.stopTrip(); this.trip = null;
    this.makeAmbient(); this.hub.show(g, 'gare');
    const s = g.state;
    if (s.stats.trips === 0 && s.settings.hints) this.toast('Conseil : acceptez un contrat dans la Gare, composez votre rame, puis prenez le départ.', 'info');
  }
  showHelp(fromTitle = false) {
    if (this.helpOpen) return; this.helpOpen = true;
    const wasPaused = this.trip?.paused; if (this.trip) this.trip.paused = true;
    const el = document.createElement('div'); el.className = 'modal'; el.style.zIndex = '30';
    el.innerHTML = `<div class="card" style="width:760px;max-height:92vh;overflow:auto"><h2>Comment jouer</h2>
      <p class="small">Vous conduisez <b>chaque trajet vous-même</b> : pas de pilote automatique, pas de voyage rapide. La vitesse résulte des forces appliquées au train (traction, résistance, pente, courbes, freinage). Gérez votre machine, respectez les limitations et les signaux, arrêtez-vous au repère du quai.</p>
      <div class="help-grid"><b>W / ↑</b><span>Augmenter la traction (régulateur)</span><b>S / ↓</b><span>Réduire la traction</span><b>← / A</b><span>Serrer le frein</span><b>→ / D</b><span>Desserrer le frein</span>
        <b>Espace</b><span>Frein d’urgence (maintenir)</span><b>H</b><span>Sifflet (passages à niveau !)</span><b>C</b><span>Sablage (adhérence)</span><b>Échap</b><span>Pause</span>
        <b>G</b><span>Enfourner du charbon (vapeur, maintenir)</span><b>I</b><span>Injecteur d’eau (vapeur)</span><b>B</b><span>Ventilateur de tirage (vapeur)</span><b>R / F</b><span>Allonger / raccourcir la détente (vapeur)</span>
        <b>X / V</b><span>Frein moteur +/− (diesel, électrique)</span><b>P</b><span>Pantographe (électrique)</span><b>Maj</b><span>Leviers plus rapides</span><b>M</b><span>Couper le son</span></div>
      <h3>Conseils</h3><ul class="small" style="margin:0;padding-left:18px;line-height:1.5">
        <li><b>Vapeur</b> : gardez la pression près du maximum en enfournant régulièrement (jauge « Feu »), surveillez le niveau d’eau avec l’injecteur. Détente longue pour démarrer et grimper, courte à vitesse de croisière.</li>
        <li><b>Diesel</b> : surveillez la température du moteur en côte à pleine charge. <b>Électrique</b> : coupez la traction dans les zones neutres de la caténaire.</li>
        <li><b>Freinage</b> : le frein répond avec un délai. En longue descente, utilisez le frein moteur pour éviter la surchauffe des freins. Anticipez les signaux, limitations et courbes avec le livret de ligne.</li>
        <li>Rail mouillé, gelé ou enneigé : l’adhérence chute — patinage au démarrage, enrayage au freinage. Le sable aide.</li>
        <li>Usure et pannes : inspectez et entretenez votre matériel à l’atelier. Une panne en ligne se répare sur place (pièces de rechange) ou par dépannage payant.</li>
        <li>Pas de game over : amendes, réparations, prêts bancaires et baisse de réputation sanctionnent les erreurs.</li></ul>
      <div style="margin-top:14px"><button class="primary" id="help-ok">Compris</button></div></div>`;
    document.getElementById('app')!.appendChild(el);
    (el.querySelector('#help-ok') as HTMLElement).onclick = () => { el.remove(); this.helpOpen = false; if (this.trip && !wasPaused) this.trip.paused = false; if (fromTitle) { /* reste sur le titre */ } };
  }

  // ------------------------------------------------------------ scènes d'ambiance
  private makeTitleScene() {
    try {
      const g = newGame({ seed: 'ecran-titre', startYear: 1925 }); this.titleGame = g;
      g.state.money = 1e7;
      const loco = locoByPref('s231'); void loco;
      const board = getBoard(g, g.state.location); const c = board.find(x => x.kind === 'freight' || x.kind === 'passenger') ?? board[0];
      if (!c) { this.ambient = null; return; }
      g.state.consistUids = pickWagonsAuto(g, c);
      const ev = evaluateContract(g, c, true); const { units, rented } = loadTrain(g, c, ev, true);
      const t = new Trip(g, c, units, rented, 0, ev.loaded); t.hour = 12.5; t.sim.s = 700; t.sim.v = 12; this.ambient = t; this.scene.setTrip(t, g.world);
    } catch { this.ambient = null; }
  }
  private makeAmbient() {
    try {
      const g = this.game!; const s = g.state;
      const loco = s.fleet.find(u => u.uid === s.locoUid); if (!loco) { this.ambient = null; return; }
      const nb = g.world.edges.find(e => (e.a === s.location || e.b === s.location) && (e.initial || s.builtEdges.includes(e.id)));
      if (!nb) { this.ambient = null; return; }
      const to = nb.a === s.location ? nb.b : nb.a;
      const c = { id: 'ambient', kind: 'deadhead' as const, from: s.location, to, cities: [s.location, to], edges: [nb.id], lengthM: nb.lengthM, reward: 0, expiresDay: 1e9, targetSec: 600, wagonTypes: [], label: 'Ambiance' };
      const units = [structuredClone(loco), ...s.consistUids.map(id => s.fleet.find(u => u.uid === id)).filter(Boolean).slice(0, 6).map(u => structuredClone(u!))];
      for (const u of units) u.loadT = 0;
      const t = new Trip(g, c, units, [], 0, 0); t.sim.s = t.route.startFront; t.ctl.brake = 1; t.ctl.throttle = 0; this.ambient = t; this.scene.setTrip(t, g.world);
    } catch { this.ambient = null; }
  }

  // ------------------------------------------------------------ trajet
  startTrip(rent: boolean) {
    const g = this.game!, s = g.state, c = s.contract; if (!c) return;
    const ev = evaluateContract(g, c, rent); if (!ev.ok) { this.toast(ev.errors[0], 'bad'); return; }
    if (ev.rentCost) addLedger(s, 'Location de wagons (acompte)', 0);
    const { units, rented } = loadTrain(g, c, ev, rent);
    const trip = new Trip(g, c, units, rented, ev.rentCost, ev.loaded);
    this.trip = trip; this.mode = 'drive'; document.body.classList.add('driving'); this.hub.hide(); screenEl.innerHTML = ''; this.ambient = null;
    this.scene.setTrip(trip, g.world); this.hud.attach(trip); audio.resume(); audio.startCab();
    this.lastToastId = 0; this.resultTimer = 0; this.paused = false;
    if (s.stats.trips === 0 && s.settings.hints) this.showHelp();
  }
  stopTrip() { if (this.trip) { this.hud.detach(); audio.stopCab(); } this.trip = null; document.body.classList.remove('driving'); }
  togglePause() {
    if (!this.trip || this.mode !== 'drive') return;
    if (this.paused) { this.paused = false; this.trip.paused = false; document.getElementById('pause-menu')?.remove(); return; }
    this.paused = true; this.trip.paused = true;
    const el = document.createElement('div'); el.className = 'modal'; el.id = 'pause-menu'; el.style.zIndex = '25';
    el.innerHTML = `<div class="card" style="width:340px;text-align:center"><h2>Pause</h2><div style="display:flex;flex-direction:column;gap:8px"><button class="primary" data-p="resume">Reprendre</button><button data-p="help">Aide et commandes</button><button data-p="mute">Son activé / coupé</button><button class="danger" data-p="tow">Abandonner (remorquage, paiement réduit)</button></div></div>`;
    document.getElementById('app')!.appendChild(el);
    el.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('[data-p]') as HTMLElement | null; if (!b) return; audio.ui('click');
      if (b.dataset.p === 'resume') this.togglePause(); if (b.dataset.p === 'help') this.showHelp(); if (b.dataset.p === 'mute') this.toast(audio.toggleMute() ? 'Son coupé' : 'Son activé');
      if (b.dataset.p === 'tow') { this.togglePause(); this.trip?.callTow(); } });
  }

  private finishTrip() {
    const trip = this.trip!, g = this.game!;
    this.hud.detach(); audio.stopCab(); this.mode = 'result'; document.body.classList.remove('driving');
    const st = settleTrip(g, trip); this.settlement = st; const res = trip.result();
    const c = res.contract;
    const ok = res.status === 'arrived';
    const head = res.status === 'arrived' ? '🚉 Arrivée en gare' : res.status === 'towed' ? '🛠 Train remorqué' : '💥 Accident';
    audio.ui(ok ? 'level' : 'error');
    screenEl.innerHTML = `<div class="modal"><div class="card" style="width:640px;max-height:92vh;overflow:auto"><h2>${head}</h2><div class="dim" style="margin-bottom:8px">${esc(c.label)} — ${esc(st.summary)}</div>
      <table>${st.lines.map(l => `<tr><td>${esc(l.label)}</td><td class="n ${l.kind ?? ''}">${esc(l.value)}</td></tr>`).join('')}</table>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px"><div><div class="dim small">Rémunération nette du trajet</div><b class="brass" style="font-size:24px">${fmtMoney(st.total)}</b> <span class="small ${st.reputationDelta >= 0 ? 'good' : 'bad'}">réputation ${st.reputationDelta >= 0 ? '+' : ''}${st.reputationDelta.toFixed(1)}</span></div><button class="primary" id="res-ok">Continuer</button></div></div></div>`;
    (screenEl.querySelector('#res-ok') as HTMLElement).onclick = () => { audio.ui('click'); this.trip = null; this.mode = 'hub'; this.makeAmbient(); this.hub.show(g, 'gare'); void saveGame(g, 'auto'); };
  }

  // ------------------------------------------------------------ boucle
  frame(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
    try { this.tick(dt); } catch (e) { console.error(e); }
    requestAnimationFrame(t => this.frame(t));
  }
  private tick(dt: number) {
    if (this.mode === 'drive' && this.trip) {
      const trip = this.trip, g = this.game!;
      if (!this.paused && !this.helpOpen) { this.hud.applyKeys(dt); trip.update(dt); advanceSeconds(g, dt); }
      this.scene.render(this.paused || this.helpOpen ? 0.0001 : dt);
      ctx.drawImage(this.scene.cv, 0, 0);
      this.hud.update(); audio.update(this.paused ? 0 : dt, trip); audio.tickMusic(dt, trip.light.isNight ? 'night' : 'drive');
      for (const t of trip.toasts) if (t.id > this.lastToastId) { this.lastToastId = t.id; this.toast(t.text, t.kind); }
      while (g.state.message.length) this.toast(g.state.message.shift()!, 'info');
      if (trip.status !== 'running') { this.resultTimer += dt; if (this.resultTimer > (trip.status === 'arrived' ? 1.2 : 2.0)) this.finishTrip(); }
      return;
    }
    // titre / hub : scène d'ambiance
    audio.tickMusic(dt, 'menu');
    const t = this.ambient;
    if (t) {
      const sim = t.sim;
      if (this.mode === 'title') {
        t.ctl.brake = 0; const target = 15; t.ctl.throttle = clamp((target - sim.v) * 0.25 + 0.25, 0, 1);
        if (sim.steam) { t.ctl.shovel = sim.steam.bed < 100; t.ctl.injector = sim.steam.level < 0.5; t.ctl.cutoff = 0.4; }
        if (t.sim.s > t.route.stopS - 900 || t.status !== 'running') { t.status = 'running'; sim.s = 600; sim.v = 12; t.time = 0; }
        t.update(dt);
      } else { t.ctl.brake = 1; t.ctl.throttle = 0; t.ctl.shovel = false; if (sim.steam) t.ctl.injector = sim.steam.level < 0.4; t.update(dt); }
      this.scene.render(dt); ctx.drawImage(this.scene.cv, 0, 0);
    } else { ctx.fillStyle = '#1b2230'; ctx.fillRect(0, 0, VW, VH); }
  }
}
function locoByPref(id: string) { try { return locoById(id); } catch { return null; } }
void ERAS; void worldFor; void yearNow; void fmtDate; void dateOf; void yearOf;

loadAssetOverrides();
(window as any).app = new App();
