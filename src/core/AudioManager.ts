/**
 * AudioManager
 * ------------
 * Fully procedural audio via the Web Audio API — no sound files. It synthesises
 * an ambient wind/room bed plus one-shot footsteps, jumps and landings. The
 * AudioContext can only start after a user gesture, so we lazily unlock on the
 * first pointer/key event.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Separate buses so music and effects can be mixed independently. */
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private ambientStarted = false;
  private musicStarted = false;
  private unlocked = false;
  private musicTimer: number | null = null;
  private readonly onGesture = (): void => this.unlock();

  constructor() {
    window.addEventListener('pointerdown', this.onGesture, { once: false });
    window.addEventListener('keydown', this.onGesture, { once: false });
    window.addEventListener('touchstart', this.onGesture, { once: false });
  }

  /** Create/resume the context and start the ambient bed. Safe to call often. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.7;
        this.master.connect(this.ctx.destination);
        this.sfxBus = this.ctx.createGain();
        this.sfxBus.gain.value = 0.8;
        this.sfxBus.connect(this.master);
        this.musicBus = this.ctx.createGain();
        this.musicBus.gain.value = 0.5;
        this.musicBus.connect(this.master);
        this.noiseBuffer = this.makeNoise(2);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      if (!this.ambientStarted) this.startAmbient();
      if (!this.musicStarted) this.startMusic();
      this.unlocked = true;
    } catch {
      /* audio unsupported — silently ignore */
    }
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  private startAmbient(): void {
    const ctx = this.ctx!;
    if (!this.master || !this.noiseBuffer) return;
    this.ambientStarted = true;

    // Airy wind: looped noise → lowpass, slowly modulated. Kept very low in the
    // mix — it's a bed, not a feature, so the loop never draws attention.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.value = 0.012;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.008;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(lp).connect(g).connect(this.sfxBus ?? this.master);
    src.start();
    lfo.start();

    // Barely-there low drone for room tone.
    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 55;
    const dg = ctx.createGain();
    dg.gain.value = 0.006;
    drone.connect(dg).connect(this.sfxBus ?? this.master);
    drone.start();
  }

  /**
   * A generative ambient score: a slow pad chord underneath, plus a sparse
   * pentatonic melody with a soft delay. Because it's generated rather than
   * looped, it never repeats identically — no "loop fatigue".
   */
  private startMusic(): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    this.musicStarted = true;

    // --- Warm pad: detuned triangles on a suspended chord ---
    const padGain = ctx.createGain();
    padGain.gain.value = 0.075;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 900;
    padFilter.Q.value = 0.6;
    padGain.connect(padFilter).connect(bus);
    // A minor 9th-ish stack: A2, E3, B3, C4 — open and a little melancholy.
    for (const [freq, detune] of [
      [110, -4],
      [164.81, 3],
      [246.94, -6],
      [261.63, 5],
    ] as Array<[number, number]>) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = 0.25;
      // Slow independent swell per voice so the chord breathes.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.03 + Math.random() * 0.04;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.16;
      lfo.connect(lfoG).connect(g.gain);
      osc.connect(g).connect(padGain);
      osc.start();
      lfo.start();
    }

    // --- Melody voice with a dotted delay ---
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.42;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const delayMix = ctx.createGain();
    delayMix.gain.value = 0.4;
    delay.connect(feedback).connect(delay);
    delay.connect(delayMix).connect(bus);

    // A minor pentatonic — reliably pleasant in any order.
    const scale = [440, 523.25, 587.33, 659.25, 783.99, 880, 1046.5];
    let step = 0;
    const playNote = (): void => {
      if (!this.ctx || !this.musicBus) return;
      const now = this.ctx.currentTime;
      // Mostly stepwise motion with occasional leaps, and rests for space.
      step += Math.random() < 0.7 ? (Math.random() < 0.5 ? 1 : -1) : (Math.random() < 0.5 ? 2 : -2);
      step = Math.max(0, Math.min(scale.length - 1, step));
      if (Math.random() < 0.25) return; // rest

      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = scale[step]!;
      const g = this.ctx.createGain();
      const peak = 0.055 + Math.random() * 0.03;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(peak, now + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
      osc.connect(g);
      g.connect(this.musicBus);
      g.connect(delay);
      osc.start(now);
      osc.stop(now + 1.6);

      // A soft fifth above, sometimes, for a little harmony.
      if (Math.random() < 0.35) {
        const h = this.ctx.createOscillator();
        h.type = 'sine';
        h.frequency.value = scale[step]! * 1.5;
        const hg = this.ctx.createGain();
        hg.gain.setValueAtTime(0.0001, now);
        hg.gain.exponentialRampToValueAtTime(peak * 0.4, now + 0.12);
        hg.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);
        h.connect(hg).connect(this.musicBus);
        h.start(now);
        h.stop(now + 1.3);
      }
    };

    const schedule = (): void => {
      playNote();
      // Loose, unhurried timing.
      const next = 900 + Math.random() * 1500;
      this.musicTimer = window.setTimeout(schedule, next);
    };
    this.musicTimer = window.setTimeout(schedule, 1200);
  }

  /** A soft, randomised footstep. `intensity` 0..1 scales volume/brightness. */
  footstep(intensity = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer || !this.unlocked) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + Math.random() * 700;
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    const vol = 0.12 * (0.6 + intensity * 0.6);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    src.connect(bp).connect(g).connect(this.sfxBus ?? this.master);
    src.start(now);
    src.stop(now + 0.16);
  }

  jump(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer || !this.unlocked) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, now);
    bp.frequency.exponentialRampToValueAtTime(1400, now + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    src.connect(bp).connect(g).connect(this.sfxBus ?? this.master);
    src.start(now);
    src.stop(now + 0.24);
  }

  land(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer || !this.unlocked) return;
    const now = ctx.currentTime;
    // Low thud (noise) + sub thump (sine).
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    src.connect(lp).connect(g).connect(this.sfxBus ?? this.master);
    src.start(now);
    src.stop(now + 0.22);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(120, now);
    thump.frequency.exponentialRampToValueAtTime(60, now + 0.15);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.18, now);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    thump.connect(tg).connect(this.sfxBus ?? this.master);
    thump.start(now);
    thump.stop(now + 0.2);
  }

  setMasterVolume(v: number): void {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  setMusicVolume(v: number): void {
    if (this.musicBus) this.musicBus.gain.value = Math.max(0, Math.min(1, v));
  }

  setSfxVolume(v: number): void {
    if (this.sfxBus) this.sfxBus.gain.value = Math.max(0, Math.min(1, v));
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('touchstart', this.onGesture);
    if (this.musicTimer !== null) window.clearTimeout(this.musicTimer);
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.master = null;
  }
}

