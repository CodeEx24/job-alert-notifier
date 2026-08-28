// sounds.js
//
// Small set of notification tones, synthesized with the Web Audio API
// rather than bundled audio files — no external/copyrighted assets needed,
// and it keeps the extension a few KB instead of shipping .mp3s.
//
// Used from two places:
//   - offscreen.js: actually plays the tone when a real alert fires
//     (service workers can't play audio directly, hence the offscreen doc)
//   - popup.js: plays a live preview when the user clicks "Test" while
//     picking a sound, and to populate the dropdown of choices

export const SOUND_OPTIONS = [
  { id: "default", label: "System default" },
  { id: "chime", label: "Chime (two ascending notes)" },
  { id: "ping", label: "Ping (single high note)" },
  { id: "alert", label: "Alert (three quick beeps)" },
  { id: "soft", label: "Soft tone (gentle low note)" },
  { id: "none", label: "Silent (no sound)" },
];

let sharedCtx;
function getContext() {
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return sharedCtx;
}

function tone(ctx, { freq, start, duration, type = "sine", peakGain = 0.25 }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  const t0 = ctx.currentTime + start;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peakGain, t0 + 0.02);
  gain.gain.linearRampToValueAtTime(0, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.03);
}

const SOUND_DEFS = {
  chime: (ctx) => {
    tone(ctx, { freq: 880.0, start: 0, duration: 0.18 });
    tone(ctx, { freq: 1318.5, start: 0.15, duration: 0.28 });
  },
  ping: (ctx) => {
    tone(ctx, { freq: 1046.5, start: 0, duration: 0.22 });
  },
  alert: (ctx) => {
    for (let i = 0; i < 3; i++) {
      tone(ctx, {
        freq: 987.77,
        start: i * 0.16,
        duration: 0.09,
        type: "square",
        peakGain: 0.15,
      });
    }
  },
  soft: (ctx) => {
    tone(ctx, { freq: 392.0, start: 0, duration: 0.4, peakGain: 0.2 });
  },
};

// Longest scheduled tail across all sound defs, so callers know how long to
// wait before it's safe to assume playback finished.
export const MAX_SOUND_DURATION_MS = 700;

export async function playSound(soundId) {
  if (!soundId || soundId === "none" || soundId === "default") return;
  const def = SOUND_DEFS[soundId];
  if (!def) return;
  const ctx = getContext();
  if (ctx.state === "suspended") await ctx.resume();
  def(ctx);
  await new Promise((resolve) => setTimeout(resolve, MAX_SOUND_DURATION_MS));
}
