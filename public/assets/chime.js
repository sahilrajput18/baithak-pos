// Alert sounds made in the browser (no sound files needed).
// Phones only allow sound after the person has touched the screen once, so every screen that plays
// sounds calls CHIME.unlock() from a tap. CHIME.armOnFirstTouch() does that on the first tap anywhere.
const CHIME = (() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null;

  function ensure() { if (!ctx && AC) { try { ctx = new AC(); } catch (e) { ctx = null; } } return ctx; }

  async function unlock() {
    const c = ensure();
    if (!c) return false;
    try { await c.resume(); } catch (e) {}
    try { // a silent blip, so iPhones and Android treat the page as allowed to play sound
      const o = c.createOscillator(), g = c.createGain();
      g.gain.value = 0.0001; o.connect(g); g.connect(c.destination);
      o.start(); o.stop(c.currentTime + 0.03);
    } catch (e) {}
    return c.state === 'running';
  }
  const running = () => !!ctx && ctx.state === 'running';

  // one soft bell note: quick attack, long fade
  function note(freq, at, dur, vol, type) {
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + at;
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  const bell = (f, at, dur, vol) => { note(f, at, dur, vol); note(f * 2, at, dur * 0.6, vol * 0.35); };

  const SOUNDS = {
    // new order for the kitchen: a bright three-note chime, twice
    new() { [0, 0.75].forEach(b => { bell(880, b, 0.9, 0.55); bell(1108.7, b + 0.16, 0.9, 0.55); bell(1318.5, b + 0.32, 1.1, 0.55); }); },
    // an item was cancelled: low, flat beeps, clearly different from a new order
    cancel() { [0, 0.28, 0.56].forEach(b => note(330, b, 0.22, 0.3, 'square')); },
    // food is ready (waiter's phone): two gentle notes
    ready() { bell(784, 0, 0.7, 0.4); bell(1046.5, 0.2, 0.9, 0.4); },
    // volume check
    test() { bell(988, 0, 0.8, 0.5); bell(1318.5, 0.18, 1, 0.5); },
  };

  function play(name) {
    if (!ensure() || ctx.state !== 'running') return false;
    try { (SOUNDS[name] || SOUNDS.new)(); return true; } catch (e) { return false; }
  }

  function armOnFirstTouch() {
    const go = () => { unlock(); ['pointerdown', 'keydown'].forEach(ev => document.removeEventListener(ev, go, true)); };
    ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, go, true));
  }

  return { unlock, play, running, armOnFirstTouch };
})();
