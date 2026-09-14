/* Arkiba transcription lifecycle. Web Speech is a live service: it cannot replay
 * recorded chunks. The independent, bounded memory recording is a recovery file,
 * never a claim that speech during a service outage was transcribed. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArkibaTranscription = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const AUDIO_BUDGET_BYTES = 64 * 1024 * 1024;
  let retainedAudioBytes = 0; // shared by every retained recording in this page

  function createTranscript(options) {
    let base = options.read(), count = 0, ignored = 0, interim = false;
    const spaced = text => text && !/\s$/.test(text) ? text + ' ' : text;
    return {
      result(event) {
        let text = ''; interim = false;
        for (let i = ignored; i < event.results.length; i++) {
          text += event.results[i][0].transcript;
          interim = interim || !event.results[i].isFinal;
        }
        count = event.results.length;
        options.write(spaced(base) + text);
      },
      edited() { base = options.read(); ignored = count; interim = false; },
      boundary() {
        // Preserve the last visible hypothesis as well as manual corrections.
        // The caller warns that this final phrase still needs review.
        const unconfirmed = interim;
        base = options.read(); count = 0; ignored = 0; interim = false;
        return unconfirmed;
      }
    };
  }

  function createAudioCapture(options) {
    const env = options.env || globalThis;
    const maxBytes = options.maxBytes || AUDIO_BUDGET_BYTES;
    let stream, recorder, stopped = false, failed = false, chunks = [], bytes = 0;
    let status = 'starting', mimeType = '', discontinuities = 0;
    const update = () => options.onUpdate({ status, bytes, mimeType, discontinuities,
      nearLimit: bytes >= maxBytes * 0.8 || retainedAudioBytes >= AUDIO_BUDGET_BYTES * 0.8 });
    const stopTracks = () => { if (stream) stream.getTracks().forEach(t => t.stop()); };
    const fail = (reason, finalChunk = false) => {
      if ((stopped && !finalChunk) || failed) return;
      failed = true; status = reason; discontinuities += 1;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} }
      stopTracks(); update();
    };
    const capture = {
      async start() {
        if (!env.navigator?.mediaDevices?.getUserMedia || !env.MediaRecorder) {
          status = 'unsupported'; update(); return;
        }
        update();
        try {
          stream = await env.navigator.mediaDevices.getUserMedia({ audio: true });
          if (stopped) { stopTracks(); return; }
          const preferred = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
            .find(type => env.MediaRecorder.isTypeSupported?.(type));
          recorder = new env.MediaRecorder(stream, { audioBitsPerSecond: 32000, ...(preferred ? { mimeType: preferred } : {}) });
          mimeType = recorder.mimeType || preferred || 'audio/webm';
          recorder.ondataavailable = event => {
            if (!event.data?.size) return;
            if (bytes + event.data.size > maxBytes || retainedAudioBytes + event.data.size > AUDIO_BUDGET_BYTES) { fail('full', true); return; }
            chunks.push(event.data); bytes += event.data.size; retainedAudioBytes += event.data.size; update();
          };
          recorder.onerror = () => fail('failed');
          recorder.onstop = () => {
            if (!stopped && !failed) fail('interrupted');
            else { if (!failed) status = 'saved'; update(); }
          };
          stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => fail('interrupted')));
          recorder.start(1000);
          status = 'recording'; update();
        } catch (_) { fail('unavailable'); }
      },
      stop() {
        if (stopped) return;
        stopped = true;
        if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch (_) {} }
        stopTracks();
        if (!failed) status = bytes ? 'saved' : 'empty';
        update();
      },
      blob() { return bytes ? new env.Blob(chunks, { type: mimeType }) : null; },
      discard() {
        capture.stop(); retainedAudioBytes -= bytes; chunks = []; bytes = 0; status = 'discarded'; update();
        // A queued final dataavailable must not repopulate a discarded buffer.
        if (recorder) recorder.ondataavailable = null;
      }
    };
    return capture;
  }

  function createSession(options) {
    const env = options.env || globalThis;
    const now = options.now || (() => Date.now());
    const later = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = options.clearTimeout || (id => clearTimeout(id));
    const startTimeoutMs = options.startTimeoutMs || 10000;
    // This is an event-renewed health deadline, not an interval blindly calling
    // start(). An unresponsive recognition instance is retired before retrying.
    const healthTimeoutMs = options.healthTimeoutMs || 45000;
    let phase = 'idle', reason = '', desired = false, current = null;
    let startedAt = null, stoppedAt = null, lastActivity = null, recognitionStartedAt = null, gapAt = null;
    let retryTimer = null, deadlineTimer = null, elapsedTimer = null;
    let attempts = 0, failures = 0, recoveries = 0, outageMs = 0, unconfirmed = 0;
    let results = 0, hidden = !!env.document?.hidden;
    let audio = { status: 'starting', bytes: 0, discontinuities: 0 };
    const events = options.eventTarget || env;
    const isOnline = () => env.navigator?.onLine !== false;
    const emit = () => options.onState?.(snapshot());
    function snapshot() {
      return {
        phase, reason, running: desired, pageHidden: hidden,
        elapsedMs: startedAt === null ? 0 : (stoppedAt ?? now()) - startedAt,
        attempts, recoveries, resultEvents: results, unconfirmedBoundaries: unconfirmed,
        outageMs: outageMs + (gapAt === null ? 0 : (stoppedAt ?? now()) - gapAt),
        audio: { ...audio }
      };
    }
    const capture = (options.captureFactory || createAudioCapture)({
      env, onUpdate(value) {
        audio = value;
        // The final MediaRecorder chunk can arrive after the stop notification.
        if (audio.bytes) events.addEventListener?.('beforeunload', beforeUnload);
        emit();
      }
    });
    function clearTimers() {
      if (retryTimer !== null) cancel(retryTimer);
      if (deadlineTimer !== null) cancel(deadlineTimer);
      retryTimer = deadlineTimer = null;
    }
    function retire() {
      if (!current) return;
      const old = current; current = null;
      old.onstart = old.onresult = old.onerror = old.onend = old.onaudiostart = old.onspeechstart = old.onspeechend = null;
      if (options.onBoundary?.()) unconfirmed += 1;
      try { old.abort(); } catch (_) {}
    }
    function deadline(ms, failure) {
      if (deadlineTimer !== null) cancel(deadlineTimer);
      deadlineTimer = later(() => { deadlineTimer = null; recover(failure); }, ms);
    }
    function heartbeat() {
      if (!desired) return;
      emit();
      elapsedTimer = later(heartbeat, 1000); // display clock only; never starts recognition
    }
    function markGap() { if (gapAt === null) gapAt = now(); }
    function recover(cause) {
      if (!desired) return;
      clearTimers(); retire(); markGap();
      phase = isOnline() ? 'reconnecting' : 'offline'; reason = cause;
      // Stable sessions reset backoff; repeated short failures progressively wait.
      failures += 1;
      const delay = Math.min(10000, 250 * Math.pow(2, Math.min(failures - 1, 6)));
      emit();
      if (isOnline()) retryTimer = later(() => { retryTimer = null; attempt(); }, delay);
    }
    function attempt() {
      if (!desired) return;
      clearTimers();
      if (!isOnline()) { phase = 'offline'; reason = 'offline'; markGap(); emit(); return; }
      phase = attempts ? 'reconnecting' : 'starting'; attempts += 1; emit();
      let rec;
      try { rec = new options.Recognition(); } catch (_) { recover('start-failed'); return; }
      current = rec;
      rec.lang = 'fr-FR'; rec.continuous = true; rec.interimResults = true;
      const live = () => desired && current === rec;
      const activity = () => {
        if (!live()) return;
        lastActivity = now();
        if (phase === 'listening') deadline(healthTimeoutMs, 'service-unresponsive');
      };
      rec.onstart = () => {
        if (!live()) return;
        recognitionStartedAt = now();
        if (gapAt !== null) { outageMs += now() - gapAt; gapAt = null; recoveries += 1; }
        phase = 'listening'; reason = ''; activity(); emit();
      };
      rec.onaudiostart = rec.onspeechstart = rec.onspeechend = activity;
      rec.onresult = event => {
        if (!live()) return;
        failures = 0; results += 1; activity(); options.onResult?.(event);
      };
      rec.onerror = event => {
        if (!live()) return;
        const error = event.error || 'service-error';
        if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(error)) {
          finish('error', error);
        } else {
          // Silence is not a provider failure. Do not accumulate a ten-second
          // blind window simply because the consultation paused several times.
          if (error === 'no-speech') failures = 0;
          recover(error);
        }
      };
      rec.onend = () => {
        if (!live()) return;
        if (recognitionStartedAt !== null && now() - recognitionStartedAt >= 5000) failures = 0;
        recover('service-ended');
      };
      deadline(startTimeoutMs, 'start-timeout');
      try { rec.start(); } catch (error) {
        if (error.name === 'NotAllowedError' || error.name === 'SecurityError') finish('error', 'not-allowed');
        else recover('start-failed');
      }
    }
    function online() { if (desired && phase === 'offline') attempt(); }
    function offline() { if (desired) recover('offline'); }
    function visibility() {
      hidden = !!env.document?.hidden;
      if (desired && !hidden && phase === 'listening' && now() - lastActivity >= healthTimeoutMs) recover('page-resumed');
      else emit();
    }
    function beforeUnload(event) {
      if (!desired && !audio.bytes) return;
      event.preventDefault(); event.returnValue = '';
    }
    function finish(next, cause) {
      desired = false; stoppedAt = now(); clearTimers(); retire();
      if (elapsedTimer !== null) cancel(elapsedTimer);
      elapsedTimer = null; phase = next; reason = cause;
      events.removeEventListener?.('online', online);
      events.removeEventListener?.('offline', offline);
      env.document?.removeEventListener?.('visibilitychange', visibility);
      capture.stop(); emit(); options.onStop?.(snapshot());
      if (!audio.bytes) events.removeEventListener?.('beforeunload', beforeUnload);
    }
    const session = {
      start() {
        if (phase !== 'idle') return;
        desired = true; startedAt = now();
        events.addEventListener?.('online', online);
        events.addEventListener?.('offline', offline);
        events.addEventListener?.('beforeunload', beforeUnload);
        env.document?.addEventListener?.('visibilitychange', visibility);
        // Start Web Speech in the original user gesture, including on Safari.
        attempt();
        if (desired) { capture.start(); heartbeat(); }
      },
      stop() { if (desired) finish('stopped', 'manual'); },
      snapshot,
      audioBlob: () => capture.blob(),
      discardAudio() {
        capture.discard(); if (!desired) events.removeEventListener?.('beforeunload', beforeUnload);
      }
    };
    return session;
  }
  return { createSession, createTranscript, createAudioCapture };
});
