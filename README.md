# Blasta

General MIDI through four generations of PC sound card, in the browser. You drag one slider to age a song forward from 1989 to 1998:

| Era | Card | Engine |
|---|---|---|
| 1989 | AdLib / Sound Blaster 2.0 | OPL2-style FM: 9 voices, 4 waveforms, mono |
| 1992 | Sound Blaster 16 · Windows 3.1 | OPL3-style FM: 18 voices, 8 waveforms, hard L/R stereo |
| 1994 | Sound Blaster AWE32 | EMU8000-style wavetable: 30 voices, ROM-budget bank, linear interpolation, gritty reverb |
| 1998 | Sound Blaster Live! | EMU10K1-style wavetable: 64 voices, 8-point interpolation, SF2.01 modulators, smoother reverb |

Between eras the two neighbouring cards crossfade.

**Play:** open `index.html` from any static server (GitHub Pages works), click to power on, then hit **Demo** or drop a `.mid` file on the window. You can also play live with the on-screen keys, QWERTY (A–K, Z/X for octave) or a Web MIDI keyboard.

## Where the sounds come from

- **FM**: an independent OPL-style engine. It uses log-sin/exp tables, 9-bit attenuation envelopes, KSL/KSR, feedback, tremolo/vibrato LFOs and a floating-point DAC model, with an **original** GM patch bank (`js/fmbank.js`). You can load your own `.op2` bank, such as the free DMXOPL.
- **Wavetable**: [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) by S. Christian Collins is bundled in `soundfonts/` under its license (see `soundfonts/GeneralUser-GS-LICENSE.txt`). At load time, `js/rombudget.js` "burns" it into period-shaped banks:
  - The AWE32 version is resampled to 22kHz mono with one velocity layer and half the multisamples. Attacks get cut to about 90ms, followed by loops a few pitch periods long.
  - The Live! version is resampled to 32kHz, with shorter attacks and loops.
- **Your own SoundFont**: load an `.sf2` into either slot. If it's already a period bank, untick *ROM budget*.

No Creative, E-mu, Yamaha or Microsoft data is included. Product names are used only to describe the eras.

## Files

- `js/blasta-worklet.js`: the AudioWorklet containing all four synth cores and the effects
- `js/sf2.js`, `js/rombudget.js`, `js/rom-worker.js`: SoundFont parsing and ROM burning, run off the main thread
- `js/smf.js`, `js/demo.js`: the MIDI file parser and the original demo tune
- `tests/render.html`: an offline render harness for headless Chrome that checks levels and NaNs and reports per-patch RMS
