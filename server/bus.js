import { EventEmitter } from 'node:events';

// Everything the UI should see live goes through push(type, data); the WebSocket layer relays it.
export function createBus() {
  const emitter = new EventEmitter();
  return {
    push: (type, data) => emitter.emit('push', { type, data }),
    onPush: fn => emitter.on('push', fn),
  };
}
