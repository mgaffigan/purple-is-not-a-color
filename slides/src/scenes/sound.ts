import {
  SOUND_AXIS, HEARING_LOW, HEARING_HIGH, describeHz, formatHz,
} from '../lib/axis';
import { BYPASS, getEngine, type EqSettings, type Engine } from '../lib/audio/engine';
import { SoundVoices } from '../lib/audio/voices';
import { Waterfall } from '../lib/viz/waterfall';
import { Scope } from '../lib/viz/scope';
import { ResponseCurve, type Handle } from '../lib/viz/curve';
import { FreqStrip } from '../lib/ui/freqStrip';
import { Piano } from '../lib/ui/piano';
import { $, $c, type Scene } from '../lib/scene';

const TICKS = [
  10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000,
].map((f) => ({ f, label: f >= 1000 ? `${f / 1000}k` : `${f}` }));

const EQ_PRESETS: Record<string, (cur: EqSettings) => EqSettings> = {
  bypass: () => structuredClone(BYPASS),
  lowpass: () => ({
    ...structuredClone(BYPASS),
    bands: [{ type: 'lowpass', freq: 500, q: Math.SQRT1_2, gain: 0 }, { ...BYPASS.bands[1] }],
  }),
  highpass: () => ({
    ...structuredClone(BYPASS),
    bands: [{ type: 'highpass', freq: 2000, q: Math.SQRT1_2, gain: 0 }, { ...BYPASS.bands[1] }],
  }),
  telephone: () => ({
    ...structuredClone(BYPASS),
    bands: [
      { type: 'highpass', freq: 300, q: Math.SQRT1_2, gain: 0 },
      { type: 'lowpass', freq: 3000, q: Math.SQRT1_2, gain: 0 },
    ],
  }),
  ears: () => ({ ...structuredClone(BYPASS), hearing: true }),
  narrow: (cur) => ({
    ...structuredClone(BYPASS),
    narrow: { on: true, freq: 440, octaves: cur.narrow.on ? cur.narrow.octaves : 1 },
  }),
};

/** Played under the title slide (from public/). */
const TITLE_TRACK = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/Arvo_Part_Spiegel_im_Spiegel.mp3`;

const DB_TOP = 12, DB_BOTTOM = -48;
const dbToY = (db: number) => (db - DB_BOTTOM) / (DB_TOP - DB_BOTTOM);
/** slider 0..1000 → octaves 2 … 1/100 */
const sliderToOct = (v: number) => 2 * Math.pow(1 / 200, v / 1000);
const octToSlider = (o: number) => (1000 * Math.log(o / 2)) / Math.log(1 / 200);

export class SoundScene implements Scene {
  private engine: Engine | null = getEngine();
  private voices: SoundVoices | null = null;
  private wfIn: Waterfall;
  private wfOut: Waterfall;
  private scope: Scope;
  private strip: FreqStrip;
  private piano: Piano;
  private eqCurve: ResponseCurve;
  private eq: EqSettings = structuredClone(BYPASS);
  private stage = '';
  private build = 0;
  private active = false;
  private meterBar: HTMLElement;
  private meterText: HTMLElement;
  private tdBuf = new Float32Array(8192);

  constructor(readonly root: HTMLElement) {
    const inCol = $(root, '.col.in');
    const outCol = $(root, '.col.out');
    this.wfIn = new Waterfall($c(inCol, 'canvas.wf'), { axis: SOUND_AXIS });
    this.wfOut = new Waterfall($c(outCol, 'canvas.wf'), { axis: SOUND_AXIS });
    this.scope = new Scope($c(inCol, 'canvas.scope'));
    this.meterBar = $(inCol, '.meter .bar');
    this.meterText = $(inCol, '.meter span');

    this.strip = new FreqStrip(
      $c(inCol, 'canvas.strip'),
      {
        axis: SOUND_AXIS,
        ticks: TICKS,
        regions: [
          { from: 1, to: HEARING_LOW, label: 'infrasound' },
          { from: HEARING_HIGH, to: 1e6, label: 'ultra' },
        ],
        format: (f) => `${formatHz(f)} · ${describeHz(f)}`,
        markerColor: () => '#ffd166',
      },
      {
        press: (f, shift) => {
          if (!this.voices) return;
          if (shift) this.strip.setMarkers(this.voices.toggleLatch(f));
          else this.voices.startGlide(f);
        },
        move: (f) => this.voices?.moveGlide(f),
        release: () => this.voices?.stopGlide(),
      },
    );
    this.piano = new Piano($c(inCol, 'canvas.piano'), SOUND_AXIS, {
      press: (m) => this.ensureVoices()?.startKey(m),
      move: (m) => this.voices?.moveKey(m),
      release: () => this.voices?.stopKey(),
    });

    this.eqCurve = new ResponseCurve($c(outCol, 'canvas.eq'), {
      axis: SOUND_AXIS,
      heights: (freqs, out) => {
        if (!this.engine) {
          out.fill(dbToY(0));
          return;
        }
        this.engine.eqResponse(freqs, out);
        for (let i = 0; i < out.length; i++) out[i] = dbToY(20 * Math.log10(out[i] + 1e-9));
      },
      handles: () => this.eqHandles(),
      onDrag: (id, f, _y, dy) => this.dragEq(id, f, dy),
      onWheel: (id, d) => this.dragEq(id, null, -d * 0.03),
      gridLines: [
        { y: dbToY(0), label: '0 dB' },
        { y: dbToY(-24), label: '−24' },
      ],
      caption: 'EQ — drag the dots',
    });

    this.wireChips();
    this.root.querySelector('.track-toggle')!.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = this.ensureVoices();
      if (!v) return;
      if (v.trackPlaying) v.stopTrack();
      else v.startTrack(TITLE_TRACK);
      setTimeout(() => this.updateTrackButton(), 50);
    });
    this.engine?.onChange(() => this.updateMicIndicator());
    this.updateMicIndicator();
  }

  private ensureVoices() {
    if (!this.voices && this.engine?.armed) this.voices = new SoundVoices(this.engine.genBus);
    return this.voices;
  }

  private wireChips() {
    this.root.querySelectorAll<HTMLButtonElement>('.chips button').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const v = this.ensureVoices();
        if (b.dataset.act === 'mic') {
          this.engine?.toggleMicMute();
          return;
        }
        if (b.dataset.act === 'stop') {
          v?.stopAll();
          this.strip.setMarkers([]);
        } else if (b.dataset.chord) {
          v?.setChord(v.activeChord === b.dataset.chord ? null : b.dataset.chord);
        } else if (b.dataset.noise) {
          const n = b.dataset.noise as 'white' | 'pink';
          v?.setNoise(v.activeNoise === n ? null : n);
        } else if (b.dataset.eq) {
          this.setEq(EQ_PRESETS[b.dataset.eq](this.eq));
        }
        this.syncChips();
      });
    });
    const slider = this.root.querySelector<HTMLInputElement>('.width input')!;
    slider.addEventListener('input', () => {
      this.setEq({ ...this.eq, narrow: { ...this.eq.narrow, on: true, octaves: sliderToOct(+slider.value) } });
    });
    slider.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  private syncChips() {
    const v = this.voices;
    this.root.querySelectorAll<HTMLButtonElement>('.chips button').forEach((b) => {
      let on = false;
      if (b.dataset.chord) on = v?.activeChord === b.dataset.chord;
      if (b.dataset.noise) on = v?.activeNoise === b.dataset.noise;
      if (b.dataset.eq) on = this.eqPresetName() === b.dataset.eq;
      b.classList.toggle('on', on);
    });
    this.root.classList.toggle('narrow-on', this.eq.narrow.on);
    const slider = this.root.querySelector<HTMLInputElement>('.width input')!;
    const out = this.root.querySelector<HTMLOutputElement>('.width output')!;
    slider.value = String(octToSlider(this.eq.narrow.octaves));
    const o = this.eq.narrow.octaves;
    out.textContent = o >= 1 ? `${o.toFixed(1)} oct` : `${(o * 1200).toFixed(0)}¢`;
  }

  private eqPresetName() {
    const e = this.eq;
    if (e.hearing) return 'ears';
    if (e.narrow.on) return 'narrow';
    const [a, b] = e.bands;
    if (a.type === 'bypass' && b.type === 'bypass') return 'bypass';
    if (a.type === 'lowpass' && b.type === 'bypass') return 'lowpass';
    if (a.type === 'highpass' && b.type === 'bypass') return 'highpass';
    if (a.type === 'highpass' && b.type === 'lowpass') return 'telephone';
    return '';
  }

  private eqHandles(): Handle[] {
    const hs: Handle[] = [];
    const e = this.eq;
    e.bands.forEach((b, i) => {
      if (b.type === 'bypass') return;
      const y = b.type === 'peaking' ? dbToY(b.gain) : dbToY(-3);
      hs.push({ id: `b${i}`, f: b.freq, y, label: `${i + 1}` });
    });
    if (e.narrow.on) hs.push({ id: 'n', f: e.narrow.freq, y: dbToY(0), label: '♪', color: '#7fe3ff' });
    return hs;
  }

  private dragEq(id: string, f: number | null, dy: number) {
    const e = structuredClone(this.eq);
    const clampF = (x: number) => Math.min(20000, Math.max(20, x));
    if (id === 'n') {
      if (f) e.narrow.freq = clampF(f);
      else e.narrow.octaves = Math.min(2, Math.max(0.01, e.narrow.octaves * Math.pow(2, -dy * 20)));
    } else {
      const b = e.bands[+id.slice(1)];
      if (f) b.freq = clampF(f);
      if (b.type === 'peaking') b.gain = Math.max(-40, Math.min(12, b.gain + dy * 60));
      else b.q = Math.max(0.3, Math.min(30, b.q * Math.pow(2, dy * 6)));
    }
    this.setEq(e);
  }

  private setEq(e: EqSettings) {
    this.eq = e;
    this.engine?.setEq(e);
    this.eqCurve.invalidate();
    this.syncChips();
  }

  private updateTrackButton() {
    const btn = this.root.querySelector('.track-toggle .icon');
    if (btn) btn.textContent = this.voices?.trackPlaying ? '⏸' : '▶';
  }

  private updateMicIndicator() {
    const ind = this.root.querySelector('.mic-ind')!;
    const e = this.engine;
    ind.className = 'mic-ind ' + (!e ? 'off' : e.micLive ? 'live' : e.micState === 'denied' ? 'denied' : 'off');
  }

  activate(on: boolean) {
    this.active = on;
    this.root.classList.toggle('active', on);
    this.engine?.setMicWanted(on);
    if (!on) {
      this.voices?.stopAll();
      this.strip.setMarkers([]);
      this.setEq(structuredClone(BYPASS));
      this.syncChips();
    }
  }

  setStep(stage: string, build: number) {
    const prev = this.stage;
    this.stage = stage;
    this.build = build;
    this.root.dataset.stage = stage;
    this.root.dataset.build = String(build);
    this.strip.showRegions = true;
    this.updateTrackButton();

    const v = this.ensureVoices();
    if (stage === 'title' && prev !== 'title') {
      // Arvo Pärt, Spiegel im Spiegel: near-pure tones, lovely lines on the waterfall.
      v?.startTrack(TITLE_TRACK).then((ok) => {
        if (!ok && this.stage === 'title') v.startProgression();
        this.updateTrackButton();
      });
    } else if (stage !== 'title') {
      v?.stopTrack();
      v?.stopProgression();
    }

    if (stage !== prev) {
      if (stage !== 'B') this.setEq(structuredClone(BYPASS));
    }
    this.syncChips();
  }

  /** Called by the deck once audio is armed (first gesture). */
  onArmed() {
    this.ensureVoices();
    if (this.active) {
      const stage = this.stage;
      this.stage = '';
      this.setStep(stage, this.build);
    }
  }

  frame() {
    const e = this.engine;
    if (e) {
      this.wfIn.pushAnalyser(e.inAn);
      if (this.stage === 'B') this.wfOut.pushAnalyser(e.outAn);
      if (this.stage === 'A') this.scope.draw(e.inAn);
      // total power meter
      e.inAn.getFloatTimeDomainData(this.tdBuf);
      let s = 0;
      for (let i = 0; i < this.tdBuf.length; i++) s += this.tdBuf[i] * this.tdBuf[i];
      const db = 10 * Math.log10(s / this.tdBuf.length + 1e-12);
      const frac = Math.max(0, Math.min(1, (db + 90) / 90));
      this.meterBar.style.transform = `scaleY(${frac.toFixed(3)})`;
      this.meterText.textContent = `${Math.round(db)} dB`;
    }
    this.strip.draw();
    this.piano.draw();
    this.eqCurve.draw();
  }

  key(e: KeyboardEvent) {
    // number keys 1-5 toggle chords, handy when your hands are busy
    const i = '12345'.indexOf(e.key);
    if (i >= 0) {
      const b = this.root.querySelectorAll<HTMLButtonElement>('[data-chord]')[i];
      b?.click();
      return true;
    }
    return false;
  }
}

