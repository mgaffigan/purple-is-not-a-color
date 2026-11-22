import Reveal from 'reveal.js';
import Notes from 'reveal.js/plugin/notes';
import 'reveal.js/reveal.css';
import { getEngine, isReceiver } from './audio/engine';
import type { Scene } from './scene';

type ArmableScene = Scene & { onArmed?: () => void };

/** Map each reveal <section data-scene data-stage> onto a persistent scene. */
export function initDeck(scenes: Record<string, ArmableScene>) {
  const engine = getEngine();
  let current: ArmableScene | null = null;
  let lastKey = '';

  const deck = new Reveal({
    width: 1920,
    height: 1080,
    margin: 0,
    minScale: 0.05,
    maxScale: 4,
    center: false,
    transition: 'none',
    backgroundTransition: 'none',
    controls: false,
    progress: true,
    hash: true,
    slideNumber: false,
    overview: true,
    pause: true,
    plugins: [Notes],
  });

  function sync() {
    const slide = deck.getCurrentSlide() as HTMLElement | undefined;
    if (!slide) return;
    const name = slide.dataset.scene ?? '';
    const scene = scenes[name] ?? null;
    const stage = slide.dataset.stage ?? '';
    const build = slide.querySelectorAll('.fragment.visible').length;
    if (scene !== current) {
      current?.activate(false);
      current = scene;
      current?.activate(true);
    }
    const key = `${name}/${stage}/${build}`;
    if (key !== lastKey) {
      lastKey = key;
      current?.setStep(stage, build);
    }
    document.body.dataset.scene = name;
  }

  for (const ev of ['ready', 'slidechanged', 'fragmentshown', 'fragmenthidden']) deck.on(ev, sync);

  const sceneKey = (e: KeyboardEvent) => current?.key?.(e);
  const bind = (keyCode: number, key: string, description: string, fn: (e: KeyboardEvent) => void) =>
    deck.addKeyBinding({ keyCode, key, description }, fn);
  deck.initialize().then(() => {
    bind(77, 'M', 'Mute / unmute the microphone', () => engine?.toggleMicMute());
    bind(84, 'T', 'Mute / unmute colour tones', sceneKey);
    bind(67, 'C', 'Colour-blind view', sceneKey);
    for (let i = 1; i <= 7; i++) bind(48 + i, String(i), `Preset ${i}`, sceneKey);
    sync();
  });

  // Audio can only start from a gesture in *this* window.
  const badge = document.querySelector<HTMLElement>('.arm-badge');
  if (!engine) badge?.remove();
  const arm = async () => {
    if (!engine || engine.armed) return;
    await engine.arm();
    badge?.classList.add('armed');
    Object.values(scenes).forEach((s) => s.onArmed?.());
  };
  window.addEventListener('pointerdown', arm, { capture: true });
  window.addEventListener('keydown', arm, { capture: true });

  const loop = (t: number) => {
    current?.frame(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  if (isReceiver) document.documentElement.classList.add('receiver');
  // Dev-only handle for poking at the audio graph from devtools.
  if (import.meta.env.DEV) Object.assign(window, { __deck: { deck, engine, scenes } });
  return deck;
}
