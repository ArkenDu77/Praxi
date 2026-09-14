const { createSession, createTranscript, createAudioCapture } = require('../public/transcription');

function result(text, final = true) {
  const r = [{ transcript: text }]; r.isFinal = final;
  return r;
}
function harness(options = {}) {
  const instances = [], states = [];
  const events = new EventTarget(), document = new EventTarget();
  document.hidden = false;
  const env = { navigator: { onLine: true }, document };
  class Recognition {
    constructor() { instances.push(this); }
    start() { options.start?.(this); if (!options.silentStart) this.onstart?.(); }
    abort() { this.aborted = true; this.onend?.(); }
  }
  let text = 'Notes initiales.';
  const transcript = createTranscript({ read: () => text, write: value => { text = value; } });
  const capture = { start: jest.fn(), stop: jest.fn(), blob: jest.fn(), discard: jest.fn() };
  const stopped = jest.fn();
  const session = createSession({
    Recognition, env, eventTarget: events,
    captureFactory: () => capture,
    onState: state => states.push(state), onResult: transcript.result,
    onBoundary: transcript.boundary, onStop: stopped, ...options.session
  });
  return { session, instances, env, events, states, capture, stopped,
    current: () => instances[instances.length - 1], text: () => text,
    edit(value) { text = value; transcript.edited(); }
  };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
afterEach(() => { jest.useRealTimers(); });

test('60 minutes synthetic: 360 segments, 359+ recoveries, no lost phrase or manual note', () => {
  const h = harness(); h.session.start();
  let supplied = 0, networkCuts = 0, interim = 0;
  for (let minute = 0; minute < 60; minute++) {
    for (let segment = 0; segment < 6; segment++) {
      jest.advanceTimersByTime(9000);
      const token = 'SYNTHESE_' + String(supplied++).padStart(3, '0') + '.';
      const tentative = supplied % 11 === 0;
      h.current().onresult({ results: [result(token, !tentative)] });
      if (tentative) interim += 1;
      if (supplied === 180) h.edit(h.text() + ' Note tapée pendant la consultation.');
      if (supplied % 7 === 0) { networkCuts += 1; h.current().onerror({ error: 'network' }); }
      else h.current().onend();
      expect(h.session.snapshot().phase).toBe('reconnecting');
      jest.advanceTimersByTime(1000);
      expect(h.session.snapshot().phase).toBe('listening');
    }
  }
  expect(h.session.snapshot()).toMatchObject({ elapsedMs: 3600000, attempts: 361, recoveries: 360, resultEvents: 360 });
  for (let i = 0; i < supplied; i++) {
    expect(h.text().split('SYNTHESE_' + String(i).padStart(3, '0') + '.')).toHaveLength(2);
  }
  expect(h.text()).toContain('Note tapée pendant la consultation.');
  expect(h.session.snapshot().unconfirmedBoundaries).toBe(interim);
  expect(networkCuts).toBe(51);
  expect(h.session.snapshot().outageMs).toBe(90000);
  expect(h.states.some(s => s.phase === 'stopped' || s.phase === 'error')).toBe(false);
  h.session.stop();
  expect(jest.getTimerCount()).toBe(0);
  expect(h.stopped).toHaveBeenCalledTimes(1);
  expect(h.capture.stop).toHaveBeenCalledTimes(1);
});

test('network error recovers even if the provider never sends end; stale callbacks cannot append', () => {
  const h = harness(); h.session.start();
  const old = h.current(), lateResult = old.onresult;
  old.onresult({ results: [result('Phrase provisoire.', false)] });
  old.onerror({ error: 'network' });
  expect(old.aborted).toBe(true);
  jest.advanceTimersByTime(250);
  lateResult({ results: [result('RESPONSE OBSOLETE')] });
  expect(h.text()).toBe('Notes initiales. Phrase provisoire.');
  expect(h.session.snapshot().phase).toBe('listening');
  h.session.stop();
});

test('full result lists are rebuilt without duplication; manual edits win over old interim', () => {
  const h = harness(); h.session.start();
  h.current().onresult({ results: [result('Bonjour.'), result('Question', false)] });
  h.current().onresult({ results: [result('Bonjour.'), result('Question complète.', false)] });
  expect(h.text()).toBe('Notes initiales. Bonjour.Question complète.');
  h.edit('Correction manuelle importante.');
  h.current().onresult({ results: [result('Bonjour.'), result('Question complète.'), result(' Nouvelle phrase.')] });
  expect(h.text()).toBe('Correction manuelle importante.  Nouvelle phrase.');
  h.session.stop();
  expect(h.text()).toContain('Correction manuelle importante.');
});

test('manual stop retains interim and cancels a pending retry immediately', () => {
  const h = harness(); h.session.start();
  h.current().onresult({ results: [result('Dernière phrase', false)] });
  h.current().onerror({ error: 'network' });
  h.session.stop();
  jest.advanceTimersByTime(60000);
  expect(h.instances).toHaveLength(1);
  expect(h.text()).toContain('Dernière phrase');
  expect(h.session.snapshot().phase).toBe('stopped');
  expect(jest.getTimerCount()).toBe(0);
});

test('normal silence never accumulates a long backoff window', () => {
  const h = harness(); h.session.start();
  for (let i = 0; i < 120; i++) {
    jest.advanceTimersByTime(5000);
    h.current().onerror({ error: 'no-speech' });
    jest.advanceTimersByTime(250);
    expect(h.session.snapshot().phase).toBe('listening');
  }
  expect(h.session.snapshot().recoveries).toBe(120);
  h.session.stop();
});

test.each(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'])('fatal %s stays visible and removes lifecycle listeners', error => {
  const h = harness(); h.session.start();
  h.current().onerror({ error });
  jest.advanceTimersByTime(600000);
  h.events.dispatchEvent(new Event('online'));
  expect(h.session.snapshot()).toMatchObject({ phase: 'error', reason: error, running: false });
  expect(h.instances).toHaveLength(1);
  expect(h.stopped).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('offline waits on connectivity events; audio capture is not stopped by STT outage', () => {
  const h = harness(); h.session.start();
  h.env.navigator.onLine = false; h.events.dispatchEvent(new Event('offline'));
  jest.advanceTimersByTime(120000);
  expect(h.instances).toHaveLength(1);
  expect(h.session.snapshot().phase).toBe('offline');
  expect(h.capture.stop).not.toHaveBeenCalled();
  h.env.navigator.onLine = true; h.events.dispatchEvent(new Event('online'));
  expect(h.session.snapshot()).toMatchObject({ phase: 'listening', recoveries: 1, outageMs: 120000 });
  h.session.stop();
});

test('start throws repeatedly: bounded exponential backoff, no silent exit or runaway', () => {
  const h = harness({ start() { throw new Error('start failed'); } }); h.session.start();
  jest.advanceTimersByTime(60000);
  expect(h.instances.length).toBeLessThan(15);
  expect(h.instances.length).toBeGreaterThan(6);
  expect(h.session.snapshot()).toMatchObject({ phase: 'reconnecting', running: true });
  expect(h.instances.every(i => i.aborted)).toBe(true);
  h.session.stop(); expect(jest.getTimerCount()).toBe(0);
});

test('start permission exception releases resources and remains actionable', () => {
  const error = new Error('permission'); error.name = 'NotAllowedError';
  const h = harness({ start() { throw error; } }); h.session.start();
  expect(h.session.snapshot()).toMatchObject({ phase: 'error', reason: 'not-allowed' });
  expect(h.capture.start).not.toHaveBeenCalled();
  expect(h.stopped).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('provider never emits start: explicit timeout and retry', () => {
  const h = harness({ silentStart: true }); h.session.start();
  jest.advanceTimersByTime(10000);
  expect(h.session.snapshot()).toMatchObject({ phase: 'reconnecting', reason: 'start-timeout' });
  jest.advanceTimersByTime(250);
  expect(h.instances).toHaveLength(2);
  h.session.stop();
});

test('health deadline renews from real events and retires an unresponsive instance', () => {
  const h = harness(); h.session.start();
  jest.advanceTimersByTime(44000);
  h.current().onaudiostart();
  jest.advanceTimersByTime(44000);
  expect(h.instances).toHaveLength(1);
  jest.advanceTimersByTime(1000);
  expect(h.session.snapshot()).toMatchObject({ phase: 'reconnecting', reason: 'service-unresponsive' });
  jest.advanceTimersByTime(250);
  expect(h.instances).toHaveLength(2);
  h.session.stop();
});

test('background state is visible and unload is guarded until audio explicitly discarded', () => {
  let audioUpdate;
  const h = harness({ session: { captureFactory: ({ onUpdate }) => {
    audioUpdate = onUpdate;
    return { start() { onUpdate({ status: 'recording', bytes: 5000 }); }, stop() {}, blob() {}, discard() { onUpdate({ status: 'discarded', bytes: 0 }); } };
  } } });
  h.session.start();
  h.env.document.hidden = true; h.env.document.dispatchEvent(new Event('visibilitychange'));
  expect(h.session.snapshot().pageHidden).toBe(true);
  h.session.stop();
  const unload = new Event('beforeunload', { cancelable: true }); h.events.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  h.session.discardAudio();
  const next = new Event('beforeunload', { cancelable: true }); h.events.dispatchEvent(next);
  expect(next.defaultPrevented).toBe(false);
});

function audioHarness(options = {}) {
  let recorder, stopTracks = jest.fn();
  const track = new EventTarget(); track.stop = stopTracks;
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const updates = [];
  class Recorder {
    constructor() { recorder = this; this.state = 'inactive'; this.mimeType = 'audio/webm'; }
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
  }
  const env = { MediaRecorder: Recorder, Blob, navigator: { mediaDevices: { getUserMedia: options.getUserMedia || (async () => stream) } } };
  const capture = createAudioCapture({ env, maxBytes: options.maxBytes, onUpdate: s => updates.push(s) });
  return { capture, updates, track, stream, stopTracks, recorder: () => recorder };
}

test('60 minutes of synthetic audio chunks survive stop until explicit discard', async () => {
  const h = audioHarness(); await h.capture.start();
  for (let second = 0; second < 3600; second++) h.recorder().ondataavailable({ data: new Blob([new Uint8Array(4000)]) });
  h.capture.stop();
  expect(h.capture.blob().size).toBe(14400000);
  expect(h.updates.at(-1)).toMatchObject({ status: 'saved', bytes: 14400000, discontinuities: 0 });
  h.capture.discard(); expect(h.capture.blob()).toBeNull();
  expect(h.recorder().ondataavailable).toBeNull();
});

test('audio quota never evicts older audio silently; capture stops and reports full', async () => {
  const h = audioHarness({ maxBytes: 10 }); await h.capture.start();
  h.recorder().ondataavailable({ data: new Blob(['12345678']) });
  expect(h.updates.at(-1).nearLimit).toBe(true);
  h.recorder().ondataavailable({ data: new Blob(['new-data']) });
  expect(h.updates.at(-1)).toMatchObject({ status: 'full', bytes: 8, discontinuities: 1 });
  expect(h.capture.blob().size).toBe(8);
  expect(h.stopTracks).toHaveBeenCalled();
  h.capture.discard();
});

test('the last asynchronous chunk also reports quota exhaustion after manual stop', async () => {
  const h = audioHarness({ maxBytes: 10 }); await h.capture.start();
  h.recorder().ondataavailable({ data: new Blob(['12345678']) });
  h.capture.stop();
  h.recorder().ondataavailable({ data: new Blob(['final chunk']) });
  expect(h.updates.at(-1)).toMatchObject({ status: 'full', bytes: 8, discontinuities: 1 });
  h.capture.discard();
});

test('retained recordings share one 64 MiB budget across repeated consultations', async () => {
  const first = audioHarness(), second = audioHarness();
  await first.capture.start(); await second.capture.start();
  first.recorder().ondataavailable({ data: new Blob([new Uint8Array(40 * 1024 * 1024)]) });
  first.capture.stop();
  second.recorder().ondataavailable({ data: new Blob([new Uint8Array(30 * 1024 * 1024)]) });
  expect(second.updates.at(-1).status).toBe('full');
  expect(first.capture.blob().size).toBe(40 * 1024 * 1024);
  first.capture.discard(); second.capture.discard();
});

test('device removal marks backup interrupted without discarding saved audio', async () => {
  const h = audioHarness(); await h.capture.start();
  h.recorder().ondataavailable({ data: new Blob(['audio']) });
  h.track.dispatchEvent(new Event('ended'));
  expect(h.updates.at(-1)).toMatchObject({ status: 'interrupted', bytes: 5, discontinuities: 1 });
  expect(h.capture.blob().size).toBe(5);
  h.capture.discard();
});

test('permission still pending at manual stop cannot leave an orphaned audio stream', async () => {
  let resolvePermission;
  const h = audioHarness({ getUserMedia: () => new Promise(resolve => { resolvePermission = resolve; }) });
  const pending = h.capture.start(); h.capture.stop(); resolvePermission(h.stream); await pending;
  expect(h.stopTracks).toHaveBeenCalledTimes(1);
  expect(h.recorder()).toBeUndefined();
});

test('unsupported or denied audio backup is explicit while preserving the live STT option', async () => {
  const updates = [];
  await createAudioCapture({ env: {}, onUpdate: s => updates.push(s) }).start();
  expect(updates.at(-1).status).toBe('unsupported');
  const h = audioHarness({ getUserMedia: async () => { throw new Error('denied'); } });
  await h.capture.start(); expect(h.updates.at(-1).status).toBe('unavailable');
});
