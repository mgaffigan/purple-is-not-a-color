# Purple is not a color

An interactive lightning talk for music teachers. Sound and light are both *power at frequency*. Ears hear frequency continuously; eyes sort light into three bins. Purple is the brain's name for a *chord* of red and violet.

Built with Astro, reveal.js, Tone.js and colorjs.io. Everything is bundled, so it runs offline.

## Run it

```sh
npm install
npm run dev          # http://localhost:4321
# or, for the venue:
npm run build && npm run preview
```

Use Chrome. The mic needs `localhost` (or https).

## Before the audience arrives

1. Open the deck full-screen on the projector (`F`).
2. **Click once in the deck window.** This arms audio and asks for the mic. The "click to arm" badge disappears when it's done.
3. Press `S` to open the speaker view on your laptop screen. It shows notes, a timer and the next step.

## Keys

| Key | |
|---|---|
| `→` / `Space` / `←` | next / previous step (builds included) |
| `S` | speaker view |
| `F` / `B` / `Esc` | fullscreen / blackout / overview |
| `M` | mute / unmute the mic (it only ever feeds the analysers, never the speakers) |
| `1`–`5` | sound slides: toggle chords |
| `1`–`7` | light slides: ROYGBIV |
| `T` | light slides: mute / unmute the colour tones |
| `C` | light slides: colour-blind (deuteranope) view |

Mouse:
- **Strip:** press and drag plays a pure tone or colour. Shift-click holds extra tones or colours.
- **Piano:** click or drag.
- **EQ / filter:** drag the dots. Scroll on a dot to change its width or Q.
- **🎙 / ♪ icons:** toggle the mic and the colour tones. **Title-card button:** play/pause the background track.

## Where things live

- `src/pages/index.astro`: the step list. Each `<section>` is one step, with its speaker notes in `<aside class="notes">`.
- `src/scenes/`: the three persistent scenes (sound lab, wavelets, light lab).
- `src/lib/light/`: CIE 1931 colour matching, spectra, and the light → sound mapping (exactly 40 octaves down).
- `src/lib/audio/`: the audio graph, the voices and the EQ.
