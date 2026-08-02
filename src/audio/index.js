/**
 * Audio subsystem entry point.
 *
 * All sound is synthesised with the Web Audio API -- no audio files. The
 * subsystem owns the graph, the music bed, and the event-driven one-shots.
 * Browsers block audio until a gesture, so `resume()` is called on first
 * pointer input by main.js.
 *
 * STUB -- replaced by the audio pass.
 */
export function createAudio(ctx) {
  const { bus } = ctx;
  const off = [
    bus.on('combat:hit', () => {}),
    bus.on('entity:died', () => {}),
    bus.on('item:pickup', () => {}),
  ];
  return {
    resume() {},
    update(_dt) {},
    dispose() { off.forEach((f) => f()); },
  };
}
