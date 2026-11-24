import type { Trip } from '../game/trip';
import { routeTunnel } from '../world/track';

/** Sons entièrement synthétisés (Web Audio) : moteur, vapeur, rails, freins, sifflet, météo, musique douce. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode; sfx!: GainNode; musicBus!: GainNode;
  noiseBuf!: AudioBuffer;
  volume = 0.7; musicVol = 0.5; muted = false;
  // boucles continues
  private rail?: { src: AudioBufferSourceNode; filt: BiquadFilterNode; gain: GainNode };
  private wind?: { src: AudioBufferSourceNode; filt: BiquadFilterNode; gain: GainNode };
  private rain?: { src: AudioBufferSourceNode; filt: BiquadFilterNode; gain: GainNode };
  private squeal?: { osc: OscillatorNode; gain: GainNode; filt: BiquadFilterNode };
  private dieselOsc?: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; filt: BiquadFilterNode };
  private whine?: { osc: OscillatorNode; gain: GainNode };
  private whistle?: { o1: OscillatorNode; o2: OscillatorNode; gain: GainNode; lfo: OscillatorNode };
  private vent?: { src: AudioBufferSourceNode; gain: GainNode; filt: BiquadFilterNode };
  private tunnelDelay?: DelayNode; private tunnelFb?: GainNode; private tunnelWet?: GainNode;
  private distAcc = 0; private strokeAcc = 0; private musicTimer = 0; private bellT = 0; private lastShovelCd = 0;
  active = false; private musicOn = false;

  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext; if (!AC) return;
      this.ctx = new AC();
    } catch { return; }
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.volume; this.master.connect(c.destination);
    this.sfx = c.createGain(); this.sfx.gain.value = 1;
    this.musicBus = c.createGain(); this.musicBus.gain.value = this.musicVol * 0.4;
    // écho de tunnel
    this.tunnelDelay = c.createDelay(0.5); this.tunnelDelay.delayTime.value = 0.13;
    this.tunnelFb = c.createGain(); this.tunnelFb.gain.value = 0.45; this.tunnelWet = c.createGain(); this.tunnelWet.gain.value = 0;
    this.sfx.connect(this.master); this.sfx.connect(this.tunnelDelay); this.tunnelDelay.connect(this.tunnelFb); this.tunnelFb.connect(this.tunnelDelay); this.tunnelDelay.connect(this.tunnelWet); this.tunnelWet.connect(this.master);
    this.musicBus.connect(this.master);
    const len = c.sampleRate * 2; this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0); let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = (b + 0.02 * w) / 1.02; d[i] = w * 0.6 + b * 2.5 * 0.4; }
  }
  resume() { this.init(); if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume(); }
  setVolume(v: number) { this.volume = v; if (this.master) this.master.gain.value = this.muted ? 0 : v; }
  setMusic(v: number) { this.musicVol = v; if (this.musicBus) this.musicBus.gain.value = v * 0.4; }
  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : this.volume; return this.muted; }

  private noiseSrc(): AudioBufferSourceNode { const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; return s; }

  /** Démarre les boucles de la cabine. */
  startCab() {
    if (!this.ctx || this.active) return;
    const c = this.ctx; this.active = true;
    const mk = (type: BiquadFilterType, f: number, q = 1) => { const x = c.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
    { const src = this.noiseSrc(), filt = mk('bandpass', 400, 0.7), gain = c.createGain(); gain.gain.value = 0; src.connect(filt); filt.connect(gain); gain.connect(this.sfx); src.start(); this.rail = { src, filt, gain }; }
    { const src = this.noiseSrc(), filt = mk('lowpass', 500), gain = c.createGain(); gain.gain.value = 0; src.connect(filt); filt.connect(gain); gain.connect(this.sfx); src.start(); this.wind = { src, filt, gain }; }
    { const src = this.noiseSrc(), filt = mk('highpass', 3200), gain = c.createGain(); gain.gain.value = 0; src.connect(filt); filt.connect(gain); gain.connect(this.sfx); src.start(); this.rain = { src, filt, gain }; }
    { const osc = c.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 2100; const filt = mk('bandpass', 2400, 8); const gain = c.createGain(); gain.gain.value = 0; osc.connect(filt); filt.connect(gain); gain.connect(this.sfx); osc.start(); this.squeal = { osc, gain, filt }; }
    { const osc = c.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 40; const osc2 = c.createOscillator(); osc2.type = 'square'; osc2.frequency.value = 20; const filt = mk('lowpass', 260); const gain = c.createGain(); gain.gain.value = 0; osc.connect(filt); osc2.connect(filt); filt.connect(gain); gain.connect(this.sfx); osc.start(); osc2.start(); this.dieselOsc = { osc, osc2, gain, filt }; }
    { const osc = c.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 400; const gain = c.createGain(); gain.gain.value = 0; const filt = mk('lowpass', 1800); osc.connect(filt); filt.connect(gain); gain.connect(this.sfx); osc.start(); this.whine = { osc, gain }; }
    { const o1 = c.createOscillator(), o2 = c.createOscillator(), lfo = c.createOscillator(); o1.type = 'sawtooth'; o2.type = 'sawtooth'; lfo.frequency.value = 6; const lg = c.createGain(); lg.gain.value = 5; lfo.connect(lg); lg.connect(o1.frequency); lg.connect(o2.frequency); const filt = mk('lowpass', 1600); const gain = c.createGain(); gain.gain.value = 0; o1.connect(filt); o2.connect(filt); filt.connect(gain); gain.connect(this.sfx); o1.start(); o2.start(); lfo.start(); this.whistle = { o1, o2, gain, lfo }; }
    { const src = this.noiseSrc(), filt = mk('highpass', 2500), gain = c.createGain(); gain.gain.value = 0; src.connect(filt); filt.connect(gain); gain.connect(this.sfx); src.start(); this.vent = { src, gain, filt }; }
  }
  stopCab() {
    if (!this.ctx || !this.active) return;
    this.active = false;
    const stop = (n?: { src?: AudioBufferSourceNode; osc?: OscillatorNode; osc2?: OscillatorNode; o1?: OscillatorNode; o2?: OscillatorNode; lfo?: OscillatorNode }) => { if (!n) return; for (const k of ['src', 'osc', 'osc2', 'o1', 'o2', 'lfo'] as const) { try { (n as any)[k]?.stop(); } catch { /* */ } } };
    stop(this.rail); stop(this.wind); stop(this.rain); stop(this.squeal); stop(this.dieselOsc); stop(this.whine); stop(this.whistle); stop(this.vent);
    this.rail = this.wind = this.rain = undefined; this.squeal = undefined; this.dieselOsc = undefined; this.whine = undefined; this.whistle = undefined; this.vent = undefined;
  }

  private burst(type: BiquadFilterType, freq: number, dur: number, vol: number, q = 1, attack = 0.003, when = 0) {
    const c = this.ctx!; const t = c.currentTime + when;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    src.connect(f); f.connect(g); g.connect(this.sfx); src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }
  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', when = 0, bus?: AudioNode) {
    const c = this.ctx!; const t = c.currentTime + when;
    const o = c.createOscillator(); o.type = type; o.frequency.value = freq; const g = c.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g); g.connect(bus ?? this.sfx); o.start(t); o.stop(t + dur + 0.05);
  }

  /** Effets d'interface. */
  ui(kind: 'click' | 'ok' | 'error' | 'coin' | 'alert' | 'level') {
    if (!this.ctx) return;
    switch (kind) {
      case 'click': this.tone(660, 0.07, 0.12, 'triangle'); break;
      case 'ok': this.tone(523, 0.12, 0.15, 'triangle'); this.tone(784, 0.18, 0.15, 'triangle', 0.08); break;
      case 'coin': this.tone(988, 0.1, 0.12, 'square'); this.tone(1319, 0.2, 0.12, 'square', 0.07); break;
      case 'error': this.tone(180, 0.2, 0.18, 'sawtooth'); break;
      case 'alert': this.tone(880, 0.12, 0.2, 'square'); this.tone(880, 0.12, 0.2, 'square', 0.18); break;
      case 'level': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 0.14, 'triangle', i * 0.1)); break;
    }
  }

  /** Mise à jour à chaque image pendant la conduite. */
  update(dt: number, trip: Trip) {
    const c = this.ctx; if (!c || !this.active) return;
    const sim = trip.sim, v = Math.abs(sim.v), now = c.currentTime;
    const tunnel = routeTunnel(trip.route, sim.s);
    const vn = Math.min(1, v / 35);
    this.tunnelWet!.gain.setTargetAtTime(tunnel ? 0.5 : 0, now, 0.1);
    // roulement
    this.rail!.gain.gain.setTargetAtTime(Math.min(0.22, vn * 0.3) * (tunnel ? 1.3 : 1), now, 0.1);
    this.rail!.filt.frequency.setTargetAtTime(250 + vn * 900, now, 0.1);
    // joints de rail : claquements
    this.distAcc += v * dt; const joint = 18;
    while (this.distAcc >= joint) { this.distAcc -= joint; const n = Math.min(sim.vehicles.length, 4); for (let i = 0; i < n; i++) this.burst('bandpass', 900 + Math.random() * 500, 0.06, 0.1 * Math.min(1, vn * 2), 2, 0.001, i * 0.04); }
    // vent et pluie
    const w = trip.weather;
    this.wind!.gain.gain.setTargetAtTime(Math.min(0.2, 0.02 + (w.windMs / 16) * 0.12 + vn * 0.1) * (tunnel ? 0.2 : 1), now, 0.3);
    this.wind!.filt.frequency.setTargetAtTime(300 + vn * 700, now, 0.3);
    this.rain!.gain.gain.setTargetAtTime(tunnel ? 0 : (w.kind === 'rain' ? 0.06 + w.precip * 0.1 : w.kind === 'snow' ? 0.015 : 0), now, 0.4);
    // freins
    const brk = sim.brakeP * Math.min(1, v / 8) * (v > 1.5 ? 1 : 0);
    this.squeal!.gain.gain.setTargetAtTime(brk > 0.1 ? Math.min(0.07, brk * 0.09) * (sim.brakeTempAvg > 250 ? 1.5 : 1) : 0, now, 0.05);
    this.squeal!.osc.frequency.setTargetAtTime(1900 + v * 40 + (sim.skidding ? 400 : 0), now, 0.1);
    // traction
    const L = sim.locoDef;
    if (sim.steam) {
      const wheelRps = v / (Math.PI * 1.8); const rate = wheelRps * 4; // 4 échappements par tour
      this.strokeAcc += rate * dt;
      const power = Math.min(1, sim.steam.steamUse / (L.powerKW * 10 / 3600 * 1.1));
      while (this.strokeAcc >= 1) { this.strokeAcc -= 1; this.burst('lowpass', 260 + power * 380, 0.11, 0.2 + power * 0.25, 0.8, 0.004); this.burst('bandpass', 1100, 0.05, 0.04 * (1 + power), 1, 0.002); }
      if (v < 0.8 && sim.steam.injFlow > 0) this.vent!.gain.gain.setTargetAtTime(0.03, now, 0.1);
      else this.vent!.gain.gain.setTargetAtTime(sim.steam.venting ? 0.09 : 0, now, 0.05);
      if (sim.steam.shovelCd > 0.8 && this.lastShovelCd <= 0.8) { this.burst('bandpass', 700, 0.18, 0.18, 1.2, 0.01); this.burst('lowpass', 200, 0.25, 0.25, 1, 0.05, 0.12); }
      this.lastShovelCd = sim.steam.shovelCd;
    } else if (sim.diesel) {
      const pf = sim.diesel.pf, run = sim.diesel.stalled ? 0 : 1;
      this.dieselOsc!.osc.frequency.setTargetAtTime(32 + pf * 44, now, 0.3); this.dieselOsc!.osc2.frequency.setTargetAtTime(16 + pf * 22, now, 0.3);
      this.dieselOsc!.filt.frequency.setTargetAtTime(220 + pf * 480, now, 0.3);
      this.dieselOsc!.gain.gain.setTargetAtTime(run * (0.07 + pf * 0.13), now, 0.2);
    } else if (sim.electric) {
      const e = sim.electric;
      this.whine!.osc.frequency.setTargetAtTime(220 + v * 22 + e.pf * 180, now, 0.15);
      this.whine!.gain.gain.setTargetAtTime(e.powered && e.pf > 0.03 ? Math.min(0.05, 0.01 + e.pf * 0.03) : 0, now, 0.1);
      this.dieselOsc!; 
    }
    // sifflet
    if (this.whistle) {
      const on = trip.whistleHeld;
      const steam = !!sim.steam;
      this.whistle.o1.frequency.setTargetAtTime(steam ? 466 : 392, now, 0.02); this.whistle.o2.frequency.setTargetAtTime(steam ? 587 : 494, now, 0.02);
      this.whistle.gain.gain.setTargetAtTime(on ? 0.1 : 0, now, on ? 0.04 : 0.12);
    }
    // cloche de passage à niveau
    this.bellT -= dt;
    for (const cr of trip.crossings) { const d = cr.f.s - sim.s; if (d > -30 && d < 420 && !cr.hit && this.bellT <= 0) { this.bellT = 0.42; this.tone(1480, 0.2, 0.06, 'sine'); this.tone(1480 * 1.5, 0.12, 0.025, 'sine'); break; } }
  }

  /** Musique douce et générative (pentatonique + nappes). */
  tickMusic(dt: number, mood: 'menu' | 'drive' | 'night') {
    const c = this.ctx; if (!c || this.musicVol <= 0.01) return;
    this.musicTimer -= dt;
    if (this.musicTimer > 0) return;
    const scale = mood === 'night' ? [0, 3, 5, 7, 10] : [0, 2, 4, 7, 9];
    const base = mood === 'menu' ? 196 : mood === 'night' ? 174.6 : 220;
    const n = scale[Math.floor(Math.random() * scale.length)] + (Math.random() < 0.3 ? 12 : 0);
    const f = base * Math.pow(2, n / 12);
    this.tone(f, 2.6, 0.14, 'sine', 0, this.musicBus); this.tone(f * 2.003, 1.6, 0.04, 'triangle', 0, this.musicBus);
    if (Math.random() < 0.35) { const m = scale[Math.floor(Math.random() * scale.length)]; this.tone(base * 0.5 * Math.pow(2, m / 12), 4, 0.1, 'sine', 0.2, this.musicBus); }
    this.musicTimer = 1.2 + Math.random() * 2.2;
    this.musicOn = true; void this.musicOn;
  }
}
export const audio = new AudioEngine();
