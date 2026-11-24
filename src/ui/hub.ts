import { clamp, fmtMoney, fmtNum, fmtTime } from '../core/util';
import { ERAS, GOODS, LOCOS, WAGONS, UPGRADES, eraAt, goodById, locoAvailable, wagonAvailable, locoById, wagonById, industryById, expectations, type LocoDef, type WagonDef } from '../data';
import { PARTS, partName, type Part, type Unit } from '../sim/train';
import { dateNow, edgeActive, edgeElectrified, fleetUnit, loanLimit, operatingOverhead, unitBusy, unitDef, yearNow, type Contract, type Game } from '../game/state';
import { fmtDate } from '../sim/weather';
import * as A from '../game/actions';
import { getBoard, deadheadOptions, evaluateContract, pickWagonsAuto, maxTrainMassT, wagonMatches, type Compat, PAX_KG, MAX_VEHICLES } from '../game/contracts';
import { GOALS } from '../game/goals';
import { closedEdges, priceMul, rates, capacity, popOf, passengerMul } from '../economy/economy';
import { edgeProfile } from '../world/track';
import { drawMap, pickMap, type Overlay } from './mapview';
import { distancesFrom } from '../world/graph';
import { audio } from '../audio/audio';
import { SLOTS, listSaves, type SlotInfo } from '../game/save';

export interface AppApi {
  startTrip(rent: boolean): void; saveSlot(slot: string): Promise<void>; loadSlot(slot: string): Promise<void>; toTitle(): void;
  toast(text: string, kind?: 'info' | 'warn' | 'bad' | 'good'): void; applySettings(): void;
}
type Tab = 'gare' | 'train' | 'atelier' | 'boutique' | 'carte' | 'marche' | 'finances' | 'reseau' | 'objectifs' | 'menu';
const TABS: [Tab, string][] = [['gare', '🚉 Gare & contrats'], ['train', '🚂 Train'], ['atelier', '🔧 Atelier'], ['boutique', '🛒 Matériel'], ['carte', '🗺 Carte'], ['marche', '📈 Marché'], ['reseau', '🏗 Réseau'], ['finances', '💰 Finances'], ['objectifs', '🏆 Objectifs'], ['menu', '⚙ Menu']];

const bar = (f: number, cls = '', err = 0) => `<div class="bar ${cls}"><i style="width:${clamp(f, 0, 1) * 100}%"></i>${err > 0 ? `<span class="err" style="left:${clamp(f - err, 0, 1) * 100}%;width:${Math.min(1, err * 2) * 100}%"></span>` : ''}</div>`;
const condCls = (v: number) => (v < 0.35 ? 'low' : v < 0.65 ? 'mid' : '');
const km = (m: number) => (m / 1000).toFixed(1).replace('.', ',') + ' km';

export class Hub {
  root: HTMLElement; g!: Game; app: AppApi; tab: Tab = 'gare';
  selContract: string | null = null; filter: 'all' | 'freight' | 'passenger' | 'mail' = 'all'; rent = true;
  selCity: number | null = null; selEdge: number | null = null; overlay: Overlay = 'relief'; mapGood = 'coal'; labels = true;
  selUnit: number | null = null; repairSel = new Set<Part>(); marketGood = 'coal'; saves: SlotInfo[] = []; shopTab: 'locos' | 'wagons' | 'sell' = 'locos';
  workshopTab: 'etat' | 'amelio' = 'etat';
  constructor(root: HTMLElement, app: AppApi) {
    this.root = root; this.app = app;
    root.addEventListener('click', e => this.onClick(e));
    root.addEventListener('change', e => this.onChange(e));
  }
  show(g: Game, tab?: Tab) { this.g = g; if (tab) this.tab = tab; if (this.selCity === null) this.selCity = g.state.location; void listSaves().then(s => { this.saves = s; if (this.tab === 'menu') this.render(); }); this.render(); }
  hide() { this.root.innerHTML = ''; }
  get s() { return this.g.state; } get w() { return this.g.world; }

  private flushMessages() { const s = this.s; while (s.message.length) this.app.toast(s.message.shift()!, 'info'); }

  render() {
    const s = this.s, w = this.w, year = yearNow(s), era = eraAt(year);
    this.flushMessages();
    const loanNote = s.loan > 0 ? ` <span class="dim small">(prêt ${fmtMoney(s.loan)})</span>` : '';
    let body = '';
    switch (this.tab) {
      case 'gare': body = this.tabGare(); break; case 'train': body = this.tabTrain(); break; case 'atelier': body = this.tabAtelier(); break;
      case 'boutique': body = this.tabBoutique(); break; case 'carte': body = this.tabCarte(); break; case 'marche': body = this.tabMarche(); break;
      case 'finances': body = this.tabFinances(); break; case 'reseau': body = this.tabReseau(); break; case 'objectifs': body = this.tabObjectifs(); break; case 'menu': body = this.tabMenu(); break;
    }
    const scroll = (this.root.querySelector('.hub-body') as HTMLElement | null)?.scrollTop ?? 0;
    this.root.innerHTML = `<div class="hub">
      <div class="hub-head"><div class="co">${esc(s.company)}</div>
        <div class="stat">Date<b>${fmtDate(dateNow(s))}</b></div><div class="stat">Époque<b>${era.name}</b></div>
        <div class="stat">Position<b>${esc(w.cities[s.location].name)}</b></div>
        <div class="stat">Trésorerie<b class="${s.money < 0 ? 'bad' : ''}">${fmtMoney(s.money)}</b>${loanNote}</div>
        <div class="stat">Réputation<b>${Math.round(s.reputation)}/100</b></div>
        <div class="stat">Pièces<b>${s.parts}</b></div>
        <div class="sp"></div>
        <button data-act="wait" data-n="1">+1 j</button><button data-act="wait" data-n="7">+1 sem.</button><button data-act="wait" data-n="30">+1 mois</button>
      </div>
      <div class="tabs">${TABS.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${k === this.tab ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="hub-body">${body}</div></div>`;
    const hb = this.root.querySelector('.hub-body') as HTMLElement; hb.scrollTop = scroll;
    if (this.tab === 'carte') this.paintMap();
    if (this.tab === 'finances') this.paintChart();
  }

  // ======================================================== GARE
  private routeStats(c: Contract) {
    let maxG = 0, tunnels = 0, bridges = 0, elec = 0, tot = 0;
    for (const id of c.edges) {
      const e = this.w.edges[id], p = edgeProfile(this.w, e);
      for (let i = 0; i < p.n; i++) { maxG = Math.max(maxG, Math.abs(p.elev[i + 1] - p.elev[i]) / 10); if (p.tunnel[i] && !p.tunnel[i - 1]) tunnels++; if (p.bridge[i] && !p.bridge[i - 1]) bridges++; }
      tot += e.lengthM; if (edgeElectrified(this.s, e)) elec += e.lengthM;
    }
    return { maxG: maxG * 100, tunnels, bridges, elec: elec / tot };
  }

  private tabGare(): string {
    const s = this.s, w = this.w;
    const board = getBoard(this.g, s.location).filter(c => this.filter === 'all' || c.kind === this.filter);
    board.sort((a, b) => b.reward - a.reward);
    const sel = board.find(c => c.id === this.selContract) ?? (s.contract?.id === this.selContract ? s.contract : null);
    const active = s.contract;
    const rowOf = (c: Contract) => {
      const badge = c.kind === 'freight' ? `<span class="badge f">Fret</span>` : c.kind === 'passenger' ? `<span class="badge pax">Voyageurs</span>` : `<span class="badge m">Courrier</span>`;
      return `<div class="row ${c.id === this.selContract ? 'sel' : ''}" data-act="pick" data-id="${c.id}"><div class="grow"><div class="t">${badge} ${esc(c.label)} ${c.premium ? '<span class="badge p">Urgent</span>' : ''}</div>
        <div class="s">${km(c.lengthM)} · objectif ${fmtTime(c.targetSec)} · ${c.kind === 'passenger' ? '' : Math.round(c.tonnes!) + ' t · '}expire dans ${Math.max(1, Math.round(c.expiresDay - s.day))} j</div></div><b class="brass">${fmtMoney(c.reward)}</b></div>`;
    };
    let detail = '<div class="dim">Choisissez un contrat dans la liste pour voir l’itinéraire, les contraintes et la rentabilité.</div>';
    if (sel) {
      const ev = evaluateContract(this.g, sel, this.rent), st = this.routeStats(sel);
      const dest = w.cities[sel.to]; const year = yearNow(s);
      const mul = sel.goodId && sel.kind === 'freight' ? priceMul(w, s.eco, year, sel.to, sel.goodId) : 1;
      detail = `<h3 style="margin-top:0">${esc(sel.label)}</h3>
      <div class="kv"><span>Itinéraire</span><span>${sel.cities.map(i => esc(w.cities[i].name)).join(' → ')}</span>
        <span>Distance</span><span>${km(sel.lengthM)} (${sel.edges.length} section${sel.edges.length > 1 ? 's' : ''})</span>
        <span>Profil</span><span>pente max ${fmtNum(st.maxG, 1)} % · ${st.tunnels} tunnel(s) · ${st.bridges} pont(s)</span>
        <span>Électrification</span><span>${Math.round(st.elec * 100)} % de l’itinéraire</span>
        <span>Temps visé</span><span>${fmtTime(sel.targetSec)} (au-delà de +25 %, le prix baisse)</span>
        ${sel.kind === 'freight' ? `<span>Chargement</span><span>${Math.round(sel.tonnes!)} t de ${goodById(sel.goodId!).name.toLowerCase()} · wagons : ${sel.wagonTypes.join(', ')}</span><span>Demande à ${esc(dest.name)}</span><span>prix ×${mul.toFixed(2)} ${mul > 1.2 ? '<span class="good">(forte demande)</span>' : mul < 0.8 ? '<span class="bad">(marché saturé)</span>' : ''}</span>` : ''}
        ${sel.kind === 'passenger' ? `<span>Voyageurs</span><span>1ʳᵉ : ${sel.pax!.c1} · 2ᵉ : ${sel.pax!.c2} · 3ᵉ : ${sel.pax!.c3}</span>` : ''}
        ${sel.kind === 'mail' ? `<span>Chargement</span><span>${sel.tonnes} t de courrier et bagages</span>` : ''}
        <span>Rémunération</span><span class="brass"><b>${fmtMoney(ev.reward)}</b>${ev.loaded < (sel.tonnes ?? (sel.pax ? sel.pax.c1 + sel.pax.c2 + sel.pax.c3 : 1)) ? ' <span class="bad">(partielle)</span>' : ''}</span></div>
      <div style="margin-top:8px"><label><input type="checkbox" data-act="rent" ${this.rent ? 'checked' : ''}> Louer les wagons manquants (≈ 5 % du prix du wagon)</label></div>
      ${ev.errors.map(e => `<div class="err-box">✖ ${esc(e)}</div>`).join('')}${ev.warnings.map(e => `<div class="warn-box">⚠ ${esc(e)}</div>`).join('')}
      <div class="small dim" style="margin:6px 0">Capacité de la rame : ${Math.round(ev.capacity)} ${sel.kind === 'passenger' ? 'places' : 't'} · masse ≈ ${Math.round(ev.massT)} t${ev.rentNeeded.length ? ` · location ${fmtMoney(ev.rentCost)}` : ''}</div>
      <button class="primary" data-act="accept" data-id="${sel.id}" ${ev.ok && !active ? '' : 'disabled'}>Accepter le contrat</button>`;
    }
    const dh = deadheadOptions(this.g, s.location);
    return `<div class="grid2"><div>
      <h2>Tableau des contrats — ${esc(w.cities[s.location].name)}</h2>
      ${active ? `<div class="panel" style="border-color:var(--brass);margin-bottom:10px"><h3 style="margin-top:0">Contrat en cours</h3><div class="t">${esc(active.label)} · ${km(active.lengthM)} · <b class="brass">${fmtMoney(active.reward)}</b></div>
        <div style="margin-top:8px;display:flex;gap:8px"><button class="primary" data-act="goTrain">Préparer le train et partir ➜</button><button data-act="cancel" class="danger">Annuler (−1 réputation)</button></div></div>` : ''}
      <div class="toggle" style="margin-bottom:8px;display:flex;gap:6px">${(['all', 'freight', 'passenger', 'mail'] as const).map(f => `<button class="small ${this.filter === f ? 'on' : ''}" data-act="filter" data-f="${f}">${{ all: 'Tous', freight: 'Fret', passenger: 'Voyageurs', mail: 'Courrier' }[f]}</button>`).join('')}</div>
      <div class="list">${board.map(rowOf).join('') || '<div class="dim">Aucun contrat disponible pour le moment. Patientez quelques jours.</div>'}</div>
      <h3>Marche à vide (repositionnement)</h3><div class="list">${dh.map(c => `<div class="row" data-act="deadhead" data-id="${c.id}"><div class="grow"><div class="t">${esc(c.label)}</div><div class="s">${km(c.lengthM)} · conduite sans charge</div></div></div>`).join('') || '<div class="dim">Aucune ligne ouverte depuis cette gare.</div>'}</div>
    </div><div class="panel">${detail}</div></div>`;
  }

  // ======================================================== TRAIN
  private tabTrain(): string {
    const s = this.s, w = this.w;
    const locos = s.fleet.filter(u => u.kind === 'loco'), wagons = s.fleet.filter(u => u.kind === 'wagon' && !u.rented);
    const c = s.contract;
    const ev = c ? evaluateContract(this.g, c, this.rent) : null;
    const loco = s.locoUid !== null ? fleetUnit(s, s.locoUid) : undefined; const ld = loco ? locoById(loco.defId) : null;
    const depot = A.hasDepot(this.g);
    const wRow = (u: Unit) => {
      const d = wagonById(u.defId), inC = s.consistUids.includes(u.uid), busy = unitBusy(s, u.uid);
      const match = c ? wagonMatches(d, c) : false;
      const cap = d.type === 'coach' ? `${d.seats.c1 + d.seats.c2 + d.seats.c3} places` : `${d.capacityT} t`;
      return `<div class="row ${inC ? 'sel' : ''}" data-act="togglew" data-id="${u.uid}"><input type="checkbox" ${inC ? 'checked' : ''} ${busy ? 'disabled' : ''} tabindex="-1" style="pointer-events:none"><div class="grow"><div class="t">${esc(d.name)} ${match ? '<span class="badge f">adapté</span>' : ''}${busy ? '<span class="badge m">atelier</span>' : ''}</div><div class="s">${cap} · usure moy. ${Math.round(avg(u) * 100)} % · ${d.lengthM} m</div></div></div>`;
    };
    const lRow = (u: Unit) => { const d = locoById(u.defId), on = u.uid === s.locoUid, busy = unitBusy(s, u.uid);
      return `<div class="row ${on ? 'sel' : ''}" data-act="selloco" data-id="${u.uid}"><div class="grow"><div class="t">${esc(d.name)} ${busy ? '<span class="badge m">atelier</span>' : ''}</div><div class="s">${d.traction === 'steam' ? 'Vapeur' : d.traction === 'diesel' ? 'Diesel' : 'Électrique'} · ${d.powerKW} kW · ${d.maxSpeedKmh} km/h · usure ${Math.round(avg(u) * 100)} % · ${Math.round(u.km)} km</div></div></div>`; };
    const fuel = loco ? A.fuelState(loco) : { fuel: 1, water: 1 };
    const rc = loco ? A.refuelCost(this.g, loco) : 0;
    const rec = ld ? maxTrainMassT(ld.maxTEkN, ld.drivingMassT, ld.powerKW) : 0;
    return `<div class="grid2"><div>
      <h2>Locomotive</h2><div class="list">${locos.map(lRow).join('')}</div>
      <h2 style="margin-top:14px">Rame <span class="dim small">(${s.consistUids.length} wagons${depot ? '' : ' — composition possible au dépôt uniquement'})</span></h2>
      ${c ? `<button class="small" data-act="auto">Composer automatiquement pour le contrat</button>` : ''}
      <div class="list" style="margin-top:8px">${wagons.map(wRow).join('') || '<div class="dim">Aucun wagon : achetez-en dans l’onglet Matériel.</div>'}</div>
    </div><div>
      <div class="panel"><h3 style="margin-top:0">Départ</h3>
      ${c ? `<div class="t"><b>${esc(c.label)}</b> · ${km(c.lengthM)} · <span class="brass">${fmtMoney(ev?.reward ?? c.reward)}</span></div>` : '<div class="warn-box">Aucun contrat accepté. Choisissez un contrat dans l’onglet Gare, ou une marche à vide.</div>'}
      ${ev ? ev.errors.map(e => `<div class="err-box">✖ ${esc(e)}</div>`).join('') + ev.warnings.map(e => `<div class="warn-box">⚠ ${esc(e)}</div>`).join('') : ''}
      ${ev ? `<div class="kv" style="margin:8px 0"><span>Véhicules</span><span>${ev.vehicles} / ${MAX_VEHICLES}</span><span>Masse</span><span>≈ ${Math.round(ev.massT)} t (conseillé ≤ ${Math.round(rec)} t)</span><span>Longueur</span><span>≈ ${Math.round(ev.lengthM)} m</span><span>Capacité</span><span>${Math.round(ev.capacity)} ${c!.kind === 'passenger' ? 'places' : 't'}</span></div>
      <label><input type="checkbox" data-act="rent" ${this.rent ? 'checked' : ''}> Louer les wagons manquants (${ev.rentNeeded.length} · ${fmtMoney(ev.rentCost)})</label>` : ''}
      <div style="margin-top:12px"><button class="primary" data-act="depart" ${ev && ev.ok ? '' : 'disabled'}>🚂 Prendre le départ</button></div></div>
      <div class="panel" style="margin-top:12px"><h3 style="margin-top:0">Approvisionnement</h3>
      ${loco && ld ? (ld.traction === 'electric' && !ld.electric?.fuelL ? '<div class="dim">Locomotive électrique : alimentée par la caténaire (facturation à la livraison).</div>' :
        `<div class="small dim">${ld.traction === 'steam' ? 'Charbon' : 'Carburant'}</div>${bar(fuel.fuel, fuel.fuel < 0.3 ? 'low' : '')}${ld.traction === 'steam' ? `<div class="small dim" style="margin-top:6px">Eau</div>${bar(fuel.water, fuel.water < 0.3 ? 'low' : '')}` : ''}
        <div style="margin-top:8px"><button data-act="refuel" ${rc > 0 || fuel.fuel < 1 ? '' : 'disabled'}>Faire le plein (${fmtMoney(rc)})</button></div>`) : ''}
      </div>
      <div class="panel" style="margin-top:12px"><h3 style="margin-top:0">Rappel des commandes</h3><div class="small dim">Accélérateur W/↑ · S/↓ — Frein ←/A (serrer) →/D (desserrer) — Urgence Espace — Sifflet H — Sable C — Pelle G, Injecteur I, Ventilateur B, Inverseur R/F (vapeur) — Frein moteur X/V, Pantographe P — Aide F1.</div></div>
    </div></div>`;
  }

  // ======================================================== ATELIER
  private tabAtelier(): string {
    const s = this.s, lvl = A.workshopLevel(this.g);
    if (lvl < 1) return `<h2>Atelier</h2><div class="warn-box">Il n’y a pas d’atelier à ${esc(this.w.cities[s.location].name)}. Rendez-vous dans une ville dotée d’un dépôt (★ carré doré sur la carte) ou construisez-en un dans l’onglet Réseau.</div>${this.unitTable(false)}`;
    const u = this.selUnit !== null ? fleetUnit(s, this.selUnit) : undefined;
    const price = Math.round(A.PARTS_PRICE * (1 - 0.05 * (lvl - 1)));
    return `<div style="display:flex;align-items:center;gap:14px"><h2 style="margin:0">Atelier niveau ${lvl}</h2><span class="dim small">Pièces en stock : <b class="ink">${s.parts}</b></span>
      <button class="small" data-act="parts" data-n="5">+5 pièces (${fmtMoney(price * 5)})</button><button class="small" data-act="parts" data-n="20">+20 (${fmtMoney(price * 20)})</button></div>
      <div class="grid2" style="margin-top:10px"><div>${this.unitTable(true)}</div><div>${u ? this.unitDetail(u) : '<div class="panel dim">Sélectionnez un matériel pour inspecter, réparer ou améliorer.</div>'}</div></div>`;
  }
  private unitTable(workshop: boolean): string {
    const s = this.s;
    const rows = s.fleet.map(u => { const d = unitDef(u), busy = unitBusy(s, u.uid);
      const worst = PARTS.filter(p => !(u.kind === 'wagon' && p === 'powerplant')).reduce((m, p) => Math.min(m, A.estimatedCond(this.g, u, p).value), 1);
      return `<div class="row ${u.uid === this.selUnit ? 'sel' : ''}" ${workshop ? `data-act="selunit" data-id="${u.uid}"` : ''}><div class="grow"><div class="t">${esc(d.name)} ${u.kind === 'loco' ? '<span class="badge p">loco</span>' : ''} ${busy ? `<span class="badge m">atelier jusqu’au ${Math.max(1, Math.ceil(busy.readyDay - s.day))} j</span>` : ''}</div>
        <div class="s">${Math.round(u.km)} km · pire pièce ≈ ${Math.round(worst * 100)} %</div>${bar(worst, condCls(worst))}</div></div>`; });
    return `<div class="list">${rows.join('')}</div>`;
  }
  private unitDetail(u: Unit): string {
    const s = this.s, d = unitDef(u), busy = unitBusy(s, u.uid);
    const traction = u.kind === 'loco' ? (d as LocoDef).traction : undefined;
    const parts = PARTS.filter(p => !(u.kind === 'wagon' && p === 'powerplant'));
    const chosen = [...this.repairSel].filter(p => parts.includes(p));
    const q = A.repairQuote(this.g, u, chosen);
    const inspected = u.inspectedKm !== null ? `inspecté il y a ${Math.round(u.km - u.inspectedKm)} km` : 'jamais inspecté';
    const up = UPGRADES.filter(x => A.upgradeQuote(u, x.id));
    return `<div class="panel"><h3 style="margin-top:0">${esc(d.name)}</h3><div class="small dim">${inspected} — l’état affiché est <b>estimé</b> : la zone claire montre l’incertitude. Inspectez pour des valeurs précises.</div>
      <div style="margin:8px 0;display:flex;gap:6px;flex-wrap:wrap"><button class="small ${this.workshopTab === 'etat' ? 'primary' : ''}" data-act="wtab" data-t="etat">État & réparations</button><button class="small ${this.workshopTab === 'amelio' ? 'primary' : ''}" data-act="wtab" data-t="amelio">Améliorations</button></div>
      ${this.workshopTab === 'etat' ? `
      <table>${parts.map(p => { const e = A.estimatedCond(this.g, u, p); return `<tr><td style="width:24px"><input type="checkbox" data-act="rp" data-p="${p}" ${this.repairSel.has(p) ? 'checked' : ''} ${busy ? 'disabled' : ''}></td><td>${partName(p, traction)}</td><td style="width:42%">${bar(e.value, condCls(e.value), e.err)}</td><td class="n">${Math.round(e.value * 100)} % <span class="dim small">±${Math.round(e.err * 100)}</span></td></tr>`; }).join('')}</table>
      <div class="small dim" style="margin:8px 0">Sélection : ${chosen.length ? `${fmtMoney(q.cost)} · ${q.partsNeeded} pièces · ${q.days} jours d’immobilisation` : 'aucune pièce'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><button data-act="inspect" ${busy ? 'disabled' : ''}>Inspecter (${fmtMoney(A.INSPECT_PRICE[u.kind])})</button><button class="primary" data-act="repair" ${chosen.length && !busy ? '' : 'disabled'}>Réparer la sélection</button><button data-act="overhaul" ${busy ? 'disabled' : ''}>Révision générale</button></div>` :
      `<div class="list">${up.map(x => { const uq = A.upgradeQuote(u, x.id)!; return `<div class="row"><div class="grow"><div class="t">${esc(x.name)} <span class="badge">niv. ${uq.level}/${uq.max}</span></div><div class="s">${esc(x.effect)}</div></div>${uq.level < uq.max ? `<button class="small primary" data-act="upgrade" data-u="${x.id}">${fmtMoney(uq.price)}</button>` : '<span class="good">max</span>'}</div>`; }).join('') || '<div class="dim">Aucune amélioration disponible.</div>'}</div>`}
    </div>`;
  }

  // ======================================================== BOUTIQUE
  private tabBoutique(): string {
    const s = this.s, year = yearNow(s), depot = A.hasDepot(this.g);
    const sub = `<div class="toggle" style="display:flex;gap:6px;margin-bottom:10px">${([['locos', 'Locomotives'], ['wagons', 'Wagons'], ['sell', 'Revendre']] as const).map(([k, l]) => `<button class="small ${this.shopTab === k ? 'on' : ''}" data-act="shoptab" data-t="${k}">${l}</button>`).join('')}</div>`;
    if (!depot) return `<h2>Matériel</h2><div class="warn-box">Les achats et ventes se font dans une ville dotée d’un dépôt.</div>`;
    if (this.shopTab === 'locos') {
      const list = LOCOS.filter(l => locoAvailable(l, year)).sort((a, b) => a.price - b.price);
      return `<h2>Locomotives disponibles en ${year}</h2>${sub}<div class="list">${list.map(l => `<div class="row"><div class="grow"><div class="t">${esc(l.name)} <span class="badge ${l.traction === 'steam' ? 'p' : l.traction === 'diesel' ? 'f' : 'pax'}">${l.traction === 'steam' ? 'vapeur' : l.traction === 'diesel' ? 'diesel' : 'électrique'}</span></div>
        <div class="s">${esc(l.desc)}</div><div class="s">${l.powerKW} kW · effort ${l.maxTEkN} kN · ${l.maxSpeedKmh} km/h · ${l.massT} t · fiabilité ${Math.round(l.reliability * 100)} % · masse conseillée ≈ ${Math.round(maxTrainMassT(l.maxTEkN, l.drivingMassT, l.powerKW))} t</div></div>
        <button class="primary small" data-act="buyloco" data-id="${l.id}" ${s.money >= l.price ? '' : 'disabled'}>${fmtMoney(l.price)}</button></div>`).join('')}</div>`;
    }
    if (this.shopTab === 'wagons') {
      const list = WAGONS.filter(x => wagonAvailable(x, year)).sort((a, b) => a.type.localeCompare(b.type) || a.price - b.price);
      const tn: Record<string, string> = { coach: 'Voyageurs', mail: 'Courrier', open: 'Vrac', flat: 'Plat', covered: 'Couvert', cattle: 'Bétail', tank: 'Citerne', reefer: 'Réfrigéré', container: 'Conteneurs' };
      return `<h2>Wagons disponibles en ${year}</h2>${sub}<div class="list">${list.map(x => `<div class="row"><div class="grow"><div class="t">${esc(x.name)} <span class="badge f">${tn[x.type]}</span></div>
        <div class="s">${x.type === 'coach' ? `${x.seats.c1 ? '1ʳᵉ : ' + x.seats.c1 + ' ' : ''}${x.seats.c2 ? '2ᵉ : ' + x.seats.c2 + ' ' : ''}${x.seats.c3 ? '3ᵉ : ' + x.seats.c3 + ' ' : ''}· confort ${Math.round(x.comfort * 100)} %` : `${x.capacityT} t`} · tare ${x.tareT} t · ${x.maxSpeedKmh} km/h</div></div>
        <button class="primary small" data-act="buywagon" data-id="${x.id}" ${s.money >= x.price ? '' : 'disabled'}>${fmtMoney(x.price)}</button></div>`).join('')}</div>`;
    }
    return `<h2>Revente</h2>${sub}<div class="list">${s.fleet.filter(u => !u.rented).map(u => `<div class="row"><div class="grow"><div class="t">${esc(unitDef(u).name)}</div><div class="s">usure moy. ${Math.round(avg(u) * 100)} % · ${Math.round(u.km)} km</div></div><button class="small" data-act="sell" data-id="${u.uid}">Vendre ${fmtMoney(A.unitValue(u))}</button></div>`).join('')}</div>`;
  }

  // ======================================================== CARTE
  private tabCarte(): string {
    const s = this.s, w = this.w, year = yearNow(s);
    const c = this.selCity !== null ? w.cities[this.selCity] : null;
    const e = this.selEdge !== null ? w.edges[this.selEdge] : null;
    let info = '<div class="dim">Cliquez sur une ville ou une ligne.</div>';
    if (c) {
      const pop = popOf(w, s.eco, year, c.id);
      const connected = w.edges.some(x => (x.a === c.id || x.b === c.id) && edgeActive(s, x));
      const goods = GOODS.filter(g => g.id !== 'mail');
      const dep = s.depots[c.id], wh = s.warehouses[c.id] ?? 0;
      info = `<h3 style="margin-top:0">${esc(c.name)} ${c.id === s.hq ? '★ siège' : ''}</h3>
      <div class="kv"><span>Région</span><span>${esc(w.regions[c.region].name)}</span><span>Population</span><span>${fmtNum(pop * 1000)} hab.</span><span>Relief</span><span>${{ plains: 'plaine', coast: 'côte', mountain: 'montagne', hills: 'collines', forest: 'forêt' }[c.terrain]}, altitude ${Math.round(c.elev)} m</span>
      <span>Industries</span><span>${c.industries.map(i => industryById(i).name).join(', ') || '—'}</span><span>Raccordement</span><span>${connected ? '<span class="good">relié au réseau</span>' : '<span class="bad">non raccordé</span>'}</span>
      <span>Dépôt</span><span>${dep !== undefined ? 'atelier niv. ' + dep : '—'}</span><span>Entrepôt</span><span>${wh ? 'niv. ' + wh : '—'}</span></div>
      <div style="margin:8px 0;display:flex;gap:6px;flex-wrap:wrap">
        ${dep === undefined ? `<button class="small" data-act="build" data-k="depot" data-id="${c.id}">Construire un dépôt (${fmtMoney(A.depotCost(w, c.id))})</button>` : dep < 3 ? `<button class="small" data-act="build" data-k="workshop" data-id="${c.id}">Atelier niv. ${dep + 1} (${fmtMoney(A.workshopCost(dep))})</button>` : ''}
        ${wh < 3 ? `<button class="small" data-act="build" data-k="warehouse" data-id="${c.id}">Entrepôt niv. ${wh + 1} (${fmtMoney(A.warehouseCost(wh))})</button>` : ''}</div>
      <table><tr><th>Bien</th><th class="n">Prix</th><th class="n">Stock</th><th class="n">Prod./Cons. (t/j)</th></tr>${goods.map(g => { const r = rates(w, s.eco, year, c.id, g.id); if (r.prod + r.cons <= 0) return ''; const m = priceMul(w, s.eco, year, c.id, g.id); return `<tr><td>${g.name}</td><td class="n ${m > 1.25 ? 'good' : m < 0.8 ? 'bad' : ''}">${fmtNum(g.base * m, 1)} Cr <span class="dim small">×${m.toFixed(2)}</span></td><td class="n">${Math.round(s.eco.stocks[c.id][g.id] ?? 0)}</td><td class="n">${r.prod ? '+' + Math.round(r.prod) : ''}${r.prod && r.cons ? ' / ' : ''}${r.cons ? '−' + Math.round(r.cons) : ''}</td></tr>`; }).join('')}</table>`;
    } else if (e) {
      const active = edgeActive(s, e), el = edgeElectrified(s, e);
      info = `<h3 style="margin-top:0">Ligne ${esc(w.cities[e.a].name)} – ${esc(w.cities[e.b].name)}</h3><div class="kv"><span>Longueur</span><span>${km(e.lengthM)}</span><span>Vitesse de ligne</span><span>${Math.min(e.maxSpeedKmh, eraAt(year).lineSpeedKmh)} km/h</span><span>Relief</span><span>${e.mountain > 0.5 ? 'montagneux' : e.mountain > 0.25 ? 'vallonné' : 'facile'}</span>
      <span>État</span><span>${active ? '<span class="good">en service</span>' : `<span class="brass">à construire — ${fmtMoney(e.buildCost)}</span>`}</span><span>Électrification</span><span>${el ? 'électrifiée' : 'non électrifiée'}</span></div>
      <div style="margin-top:8px;display:flex;gap:6px">${!active ? `<button class="small primary" data-act="build" data-k="link" data-id="${e.id}">Construire (${fmtMoney(e.buildCost)} · réput. ${A.linkRequirement(e.kind)})</button>` : !el ? `<button class="small" data-act="build" data-k="elec" data-id="${e.id}">Électrifier (${fmtMoney(A.electrifyCost(this.g, e))})</button>` : ''}</div>`;
    }
    return `<div class="grid2" style="grid-template-columns:1.4fr 1fr"><div><div class="toggle" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
      ${([['relief', 'Relief'], ['regions', 'Régions'], ['prices', 'Prix d’un bien']] as const).map(([k, l]) => `<button class="small ${this.overlay === k ? 'on' : ''}" data-act="overlay" data-o="${k}">${l}</button>`).join('')}
      ${this.overlay === 'prices' ? `<select data-act="mapgood">${GOODS.filter(g => g.id !== 'mail').map(g => `<option value="${g.id}" ${g.id === this.mapGood ? 'selected' : ''}>${g.name}</option>`).join('')}</select>` : ''}
      <button class="small ${this.labels ? 'on' : ''}" data-act="labels">Noms</button></div>
      <canvas class="map" id="mapcv"></canvas>
      <div class="legend"><span>▲ train</span><span>■ dépôt</span><span>★ siège</span><span>⁃⁃⁃ ligne pointillée blanche : à construire</span><span style="color:#8fe0ff">ligne bleutée : électrifiée</span><span style="color:#d0604a">× ligne coupée</span></div></div>
      <div class="panel">${info}</div></div>`;
  }
  private paintMap() {
    const cv = this.root.querySelector('#mapcv') as HTMLCanvasElement | null; if (!cv) return;
    drawMap(cv, this.g, { overlay: this.overlay, city: this.selCity, edge: this.selEdge, good: this.mapGood, labels: this.labels, routeEdges: this.s.contract?.edges });
    cv.onclick = ev => { const r = cv.getBoundingClientRect(); const k = pickMap(this.g, (ev.clientX - r.left) * cv.width / r.width, (ev.clientY - r.top) * cv.height / r.height); if (k.city !== undefined) { this.selCity = k.city; this.selEdge = null; } else if (k.edge !== undefined) { this.selEdge = k.edge; this.selCity = null; } else return; audio.ui('click'); this.render(); };
  }

  // ======================================================== MARCHE
  private tabMarche(): string {
    const s = this.s, w = this.w, year = yearNow(s), here = s.location;
    const g = goodById(this.marketGood);
    const { dist } = distancesFrom(w, here, e => edgeActive(s, e) && !closedEdges(s.eco).has(e.id));
    const ex = expectations(year);
    const cities = w.cities.filter(c => rates(w, s.eco, year, c.id, g.id).prod + rates(w, s.eco, year, c.id, g.id).cons > 0)
      .map(c => ({ c, m: priceMul(w, s.eco, year, c.id, g.id), st: s.eco.stocks[c.id][g.id] ?? 0, d: dist[c.id], r: rates(w, s.eco, year, c.id, g.id) }));
    const buy = [...cities].sort((a, b) => a.m - b.m).slice(0, 6), sell = [...cities].sort((a, b) => b.m - a.m).slice(0, 8);
    return `<h2>Marché des marchandises</h2><div style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><span class="dim">Bien :</span><select data-act="mgood">${GOODS.filter(x => x.id !== 'mail').map(x => `<option value="${x.id}" ${x.id === this.marketGood ? 'selected' : ''}>${x.name}</option>`).join('')}</select>
      <span class="dim small">Prix de base ${g.base} Cr/t · tarif de transport ${g.rate} Cr/t·km · fragilité ${Math.round(g.fragility * 100)} % · périssabilité ${Math.round(g.perish * 100)} %</span></div>
      <div class="grid2" style="grid-template-columns:1fr 1fr"><div class="panel"><h3 style="margin-top:0">Où ça manque (prix élevés)</h3><table><tr><th>Ville</th><th class="n">Prix</th><th class="n">Stock</th><th class="n">Distance</th></tr>${sell.map(x => `<tr><td>${esc(x.c.name)}</td><td class="n good">${fmtNum(g.base * x.m, 1)} <span class="dim small">×${x.m.toFixed(2)}</span></td><td class="n">${Math.round(x.st)}</td><td class="n">${isFinite(x.d) ? km(x.d) : '—'}</td></tr>`).join('')}</table></div>
      <div class="panel"><h3 style="margin-top:0">Où ça abonde (prix bas)</h3><table><tr><th>Ville</th><th class="n">Prix</th><th class="n">Stock</th><th class="n">Distance</th></tr>${buy.map(x => `<tr><td>${esc(x.c.name)}</td><td class="n bad">${fmtNum(g.base * x.m, 1)} <span class="dim small">×${x.m.toFixed(2)}</span></td><td class="n">${Math.round(x.st)}</td><td class="n">${isFinite(x.d) ? km(x.d) : '—'}</td></tr>`).join('')}</table></div></div>
      <div class="panel" style="margin-top:12px"><h3 style="margin-top:0">Attentes des clients en ${year}</h3><div class="small">Vitesse commerciale attendue ≈ ${Math.round(ex.speedKmh)} km/h · confort attendu ${Math.round(ex.comfort * 100)} % · vitesse de ligne ${ex.lineSpeedKmh} km/h. Les prix évoluent chaque jour avec les stocks, les événements et vos livraisons.</div></div>`;
  }

  // ======================================================== FINANCES
  private tabFinances(): string {
    const s = this.s, lim = loanLimit(s), room = lim - s.loan;
    return `<div class="grid2" style="grid-template-columns:1fr 1.2fr"><div><h2>Finances</h2>
      <div class="panel"><div class="kv"><span>Trésorerie</span><span class="${s.money < 0 ? 'bad' : ''}"><b>${fmtMoney(s.money)}</b></span><span>Prêt en cours</span><span>${fmtMoney(s.loan)} <span class="dim small">(6 % / an)</span></span><span>Plafond de prêt</span><span>${fmtMoney(lim)}</span>
      <span>Frais quotidiens</span><span>${fmtMoney(operatingOverhead(s))} / jour</span><span>Gains cumulés</span><span>${fmtMoney(s.stats.earned)}</span></div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap"><button class="small" data-act="loan" data-n="5000" ${room >= 5000 ? '' : 'disabled'}>Emprunter 5 000</button><button class="small" data-act="loan" data-n="20000" ${room >= 20000 ? '' : 'disabled'}>Emprunter 20 000</button><button class="small" data-act="repay" data-n="5000" ${s.loan > 0 ? '' : 'disabled'}>Rembourser 5 000</button><button class="small" data-act="repay" data-n="999999" ${s.loan > 0 ? '' : 'disabled'}>Tout rembourser</button></div>
      <div class="small dim" style="margin-top:8px">Pas de faillite brutale : un découvert est converti en prêt, et une locomotive de secours vous est prêtée si besoin (réputation en baisse).</div></div>
      <h3>Évolution de la trésorerie</h3><canvas class="chart" id="chart" width="520" height="120"></canvas></div>
      <div><h2>Journal des opérations</h2><div class="panel" style="max-height:480px;overflow:auto"><table>${s.ledger.slice(0, 60).map(l => `<tr><td class="dim small">j${l.day}</td><td>${esc(l.label)}</td><td class="n ${l.amount < 0 ? 'bad' : 'good'}">${l.amount > 0 ? '+' : ''}${fmtMoney(l.amount)}</td></tr>`).join('') || '<tr><td class="dim">Aucune opération</td></tr>'}</table></div></div></div>`;
  }
  private paintChart() {
    const cv = this.root.querySelector('#chart') as HTMLCanvasElement | null; if (!cv) return; const x = cv.getContext('2d')!; const s = this.s;
    const pts: number[] = [s.money]; let m = s.money; for (const l of s.ledger.slice(0, 120)) { m -= l.amount; pts.unshift(m); }
    const mn = Math.min(...pts), mx = Math.max(...pts, mn + 1);
    x.clearRect(0, 0, cv.width, cv.height); x.strokeStyle = '#e0ad4f'; x.lineWidth = 2; x.beginPath();
    pts.forEach((v, i) => { const px = (i / Math.max(1, pts.length - 1)) * (cv.width - 8) + 4, py = cv.height - 8 - ((v - mn) / (mx - mn)) * (cv.height - 16); i ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
    x.fillStyle = '#b9a98c'; x.font = '11px sans-serif'; x.fillText(fmtMoney(mx), 6, 12); x.fillText(fmtMoney(mn), 6, cv.height - 3);
  }

  // ======================================================== RESEAU
  private tabReseau(): string {
    const s = this.s, w = this.w, year = yearNow(s);
    const links = w.edges.filter(e => !edgeActive(s, e)); const unel = w.edges.filter(e => edgeActive(s, e) && !edgeElectrified(s, e)).sort((a, b) => (w.cities[b.a].pop + w.cities[b.b].pop) - (w.cities[a.a].pop + w.cities[a.b].pop)).slice(0, 8);
    const cities = [...w.cities].sort((a, b) => b.pop - a.pop).slice(0, 12);
    return `<h2>Infrastructure</h2><div class="small dim" style="margin-bottom:10px">Bâtissez votre réseau : raccordez les villes isolées, ouvrez des raccourcis, électrifiez les grandes lignes, installez des dépôts et entrepôts.</div>
      <div class="grid3"><div class="panel"><h3 style="margin-top:0">Nouvelles lignes</h3><div class="list">${links.map(e => `<div class="row"><div class="grow"><div class="t">${esc(w.cities[e.a].name)} – ${esc(w.cities[e.b].name)}</div><div class="s">${e.kind === 'branch' ? 'raccordement' : 'raccourci'} · ${km(e.lengthM)} · réput. ${A.linkRequirement(e.kind)}</div></div><button class="small primary" data-act="build" data-k="link" data-id="${e.id}">${fmtMoney(e.buildCost)}</button></div>`).join('') || '<div class="dim">Toutes les lignes sont construites.</div>'}</div></div>
      <div class="panel"><h3 style="margin-top:0">Électrification ${year < 1920 ? '<span class="dim small">(à partir de 1920)</span>' : ''}</h3><div class="list">${unel.map(e => `<div class="row"><div class="grow"><div class="t">${esc(w.cities[e.a].name)} – ${esc(w.cities[e.b].name)}</div><div class="s">${km(e.lengthM)} · réput. 40</div></div><button class="small" data-act="build" data-k="elec" data-id="${e.id}">${fmtMoney(A.electrifyCost(this.g, e))}</button></div>`).join('') || '<div class="dim">Réseau entièrement électrifié.</div>'}</div></div>
      <div class="panel"><h3 style="margin-top:0">Dépôts & entrepôts</h3><div class="list">${cities.map(c => `<div class="row"><div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${s.depots[c.id] !== undefined ? 'atelier niv. ' + s.depots[c.id] : 'pas de dépôt'} · entrepôt ${s.warehouses[c.id] ?? 0}</div></div>
        ${s.depots[c.id] === undefined ? `<button class="small" data-act="build" data-k="depot" data-id="${c.id}">${fmtMoney(A.depotCost(w, c.id))}</button>` : ''}<button class="small" data-act="build" data-k="warehouse" data-id="${c.id}" ${(s.warehouses[c.id] ?? 0) >= 3 ? 'disabled' : ''}>🏬</button></div>`).join('')}</div></div></div>`;
  }

  // ======================================================== OBJECTIFS
  private tabObjectifs(): string {
    const s = this.s, w = this.w, g = this.g, year = yearNow(s), era = eraAt(year);
    const done = (id: string) => s.goalsDone.includes(id);
    const evs = s.eco.events;
    return `<div class="grid2" style="grid-template-columns:1.1fr 1fr"><div><h2>Objectifs à long terme</h2>${s.goalsDone.includes('legend') ? '<div class="warn-box" style="color:#ffd98a">🏆 Compagnie légendaire ! Tous les objectifs sont atteints. Continuez librement.</div>' : ''}
      <div class="list">${GOALS.map(gl => { const [a, b] = gl.progress(g); return `<div class="row" style="cursor:default"><div class="grow"><div class="t">${done(gl.id) ? '✅' : '⬜'} ${esc(gl.name)} <span class="dim small">+${fmtMoney(gl.reward)}</span></div><div class="s">${esc(gl.desc)} (${Math.min(Math.round(a), b)} / ${b})</div>${bar(a / b, done(gl.id) ? '' : 'mid')}</div></div>`; }).join('')}</div></div>
      <div><h2>${era.name}</h2><div class="panel small">${esc(era.blurb)}<div class="dim" style="margin-top:6px">Les époques : ${ERAS.map(e => `<span class="${e === era ? 'brass' : ''}">${e.from}</span>`).join(' · ')}</div></div>
      <h3>Événements en cours</h3><div class="list">${evs.map(ev => `<div class="row" style="cursor:default"><div class="grow"><div class="t ${ev.positive ? 'good' : 'bad'}">${esc(ev.name)}</div><div class="s">${esc(ev.text)} — encore ${Math.max(1, Math.round(ev.endDay - s.day))} j</div></div></div>`).join('') || '<div class="dim">Aucun événement particulier.</div>'}</div>
      <h3>Actualités</h3><div class="panel" style="max-height:220px;overflow:auto">${s.eco.journal.slice(0, 20).map(j => `<div class="news ${j.positive ? '' : 'dim'}"><span class="dim small">${fmtDate({ ...dateNow({ ...s, day: j.day }), })}</span> — ${esc(j.text)}</div>`).join('') || '<div class="dim">Rien à signaler.</div>'}</div>
      <div class="panel small" style="margin-top:12px"><b>Statistiques</b><div class="kv" style="margin-top:6px"><span>Livraisons</span><span>${s.stats.deliveries}</span><span>Tonnes transportées</span><span>${Math.round(s.stats.tonnes)} t</span><span>Voyageurs</span><span>${s.stats.passengers}</span><span>Kilomètres</span><span>${Math.round(s.stats.km)} km</span><span>Régions desservies</span><span>${s.stats.regionsServed.length} / ${w.regions.length}</span><span>Pannes / accidents</span><span>${s.stats.breakdowns} / ${s.stats.accidents}</span></div></div></div></div>`;
  }

  // ======================================================== MENU
  private tabMenu(): string {
    const s = this.s;
    const slot = (id: string) => { const i = this.saves.find(x => x.slot === id); return `<div class="row" style="cursor:default"><div class="grow"><div class="t">${id === 'auto' ? 'Sauvegarde automatique' : 'Emplacement ' + id}</div><div class="s">${i ? `${esc(i.company)} · année ${i.year} · ${fmtMoney(i.money)} · ${new Date(i.savedAt).toLocaleString('fr-FR')}` : 'vide'}</div></div>${id !== 'auto' ? `<button class="small" data-act="save" data-slot="${id}">Sauvegarder</button>` : ''}<button class="small" data-act="load" data-slot="${id}" ${i ? '' : 'disabled'}>Charger</button></div>`; };
    return `<div class="grid2" style="grid-template-columns:1.2fr 1fr"><div><h2>Sauvegardes</h2><div class="list">${SLOTS.map(slot).join('')}</div></div>
      <div><h2>Options</h2><div class="panel"><div class="form-row"><label>Volume général</label><input type="range" min="0" max="100" value="${Math.round(s.settings.volume * 100)}" data-act="vol"></div>
      <div class="form-row"><label>Musique</label><input type="range" min="0" max="100" value="${Math.round(s.settings.music * 100)}" data-act="mus"></div>
      <div class="form-row"><label>Conseils</label><label><input type="checkbox" data-act="hints" ${s.settings.hints ? 'checked' : ''}> Afficher l’aide au premier trajet</label></div>
      <div style="margin-top:12px"><button data-act="toTitle" class="danger">Retour au menu principal</button></div></div>
      <div class="panel small dim" style="margin-top:12px">Graine du monde : <b class="ink">${esc(s.seed)}</b> — pays de ${esc(this.w.country)}, ${this.w.cities.length} villes, ${this.w.regions.length} régions.</div></div></div>`;
  }

  // ======================================================== événements
  private onChange(e: Event) {
    const el = e.target as HTMLElement; const act = el.dataset.act; if (!act) return;
    const v = (el as HTMLInputElement).value;
    switch (act) {
      case 'mgood': this.marketGood = v; this.render(); break; case 'mapgood': this.mapGood = v; this.render(); break;
      case 'vol': this.s.settings.volume = +v / 100; audio.setVolume(+v / 100); break; case 'mus': this.s.settings.music = +v / 100; audio.setMusic(+v / 100); break;
      case 'hints': this.s.settings.hints = (el as HTMLInputElement).checked; break;
      case 'rent': this.rent = (el as HTMLInputElement).checked; this.render(); break;
      case 'rp': { const p = el.dataset.p as Part; if ((el as HTMLInputElement).checked) this.repairSel.add(p); else this.repairSel.delete(p); this.render(); break; }
    }
  }
  private res(r: A.Res, snd = true) { this.app.toast(r.msg, r.ok ? 'good' : 'bad'); if (snd) audio.ui(r.ok ? 'coin' : 'error'); this.render(); }
  private onClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null; if (!el) return;
    const act = el.dataset.act!; if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    audio.resume();
    const s = this.s, id = el.dataset.id;
    switch (act) {
      case 'tab': this.tab = el.dataset.tab as Tab; audio.ui('click'); this.render(); break;
      case 'wait': { const r = A.waitDays(this.g, +el.dataset.n!); audio.ui('click'); this.app.toast(r.msg, 'info'); this.render(); break; }
      case 'filter': this.filter = el.dataset.f as typeof this.filter; this.render(); break;
      case 'pick': this.selContract = id!; audio.ui('click'); this.render(); break;
      case 'rent': break;
      case 'accept': { const c = getBoard(this.g, s.location).find(x => x.id === id); if (c) { const r = A.acceptContract(this.g, c, this.rent); if (r.ok) { s.consistUids = this.autoConsist(c); this.tab = 'train'; } this.res(r); } break; }
      case 'deadhead': { const c = deadheadOptions(this.g, s.location).find(x => x.id === id); if (c) { const r = A.acceptContract(this.g, c, false); this.res(r); if (r.ok) { this.tab = 'train'; this.render(); } } break; }
      case 'cancel': this.res(A.cancelContract(this.g)); break;
      case 'goTrain': this.tab = 'train'; this.render(); break;
      case 'togglew': { this.res(A.toggleConsist(this.g, +id!), false); break; }
      case 'selloco': this.res(A.selectLoco(this.g, +id!), false); break;
      case 'auto': if (s.contract) { s.consistUids = this.autoConsist(s.contract); this.render(); } break;
      case 'refuel': this.res(A.refuel(this.g, s.locoUid!)); break;
      case 'depart': { const c = s.contract; if (c) { const ev = evaluateContract(this.g, c, this.rent); if (!ev.ok) { this.app.toast(ev.errors[0], 'bad'); return; } if (ev.rentCost) { A.ensureSolvent(this.g); } this.app.startTrip(this.rent); } break; }
      case 'selunit': this.selUnit = +id!; this.repairSel.clear(); this.render(); break;
      case 'wtab': this.workshopTab = el.dataset.t as typeof this.workshopTab; this.render(); break;
      case 'parts': this.res(A.buyParts(this.g, +el.dataset.n!)); break;
      case 'inspect': this.res(A.inspect(this.g, this.selUnit!)); break;
      case 'repair': this.res(A.startRepair(this.g, this.selUnit!, [...this.repairSel])); this.repairSel.clear(); break;
      case 'overhaul': this.res(A.fullOverhaul(this.g, this.selUnit!)); break;
      case 'upgrade': this.res(A.applyUpgrade(this.g, this.selUnit!, el.dataset.u!)); break;
      case 'shoptab': this.shopTab = el.dataset.t as typeof this.shopTab; this.render(); break;
      case 'buyloco': this.res(A.buyLoco(this.g, id!)); break; case 'buywagon': this.res(A.buyWagon(this.g, id!)); break; case 'sell': this.res(A.sellUnit(this.g, +id!)); break;
      case 'overlay': this.overlay = el.dataset.o as Overlay; this.render(); break; case 'labels': this.labels = !this.labels; this.render(); break;
      case 'build': { const k = el.dataset.k!, n = +id!; const r = k === 'depot' ? A.buildDepot(this.g, n) : k === 'workshop' ? A.upgradeWorkshop(this.g, n) : k === 'warehouse' ? A.buildWarehouse(this.g, n) : k === 'link' ? A.buildLink(this.g, n) : A.electrifyEdge(this.g, n); this.res(r); break; }
      case 'loan': this.res(A.takeLoan(this.g, +el.dataset.n!)); break; case 'repay': this.res(A.repayLoan(this.g, +el.dataset.n!)); break;
      case 'save': void this.app.saveSlot(el.dataset.slot!).then(() => listSaves().then(x => { this.saves = x; this.render(); })); break;
      case 'load': void this.app.loadSlot(el.dataset.slot!); break;
      case 'toTitle': this.app.toTitle(); break;
    }
  }
  private autoConsist(c: Contract): number[] { return pickWagonsAuto(this.g, c); }
}

const avg = (u: Unit) => Object.entries(u.cond).filter(([k]) => !(u.kind === 'wagon' && k === 'powerplant')).reduce((a, [, v], _i, arr) => a + v / arr.length, 0);
export const esc = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
void PAX_KG; void passengerMul; void capacity; void WAGONS;
