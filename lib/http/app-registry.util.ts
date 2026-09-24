import type { Storage } from '../storage.service.js';

/**
 * Which `Storage` belongs to which HTTP server instance (the Express app, or the Fastify
 * instance), so an upload engine created in a decorator, before any module exists, finds the
 * disks of the application that is handling the request. Several applications in one
 * process (tests) each find their own.
 */
const byServer = new WeakMap<object, Storage>();

export function registerServer(instance: object, storage: Storage): void {
  byServer.set(instance, storage);
}

export function unregisterServer(instance: object, storage: Storage): void {
  if (byServer.get(instance) === storage) {
    byServer.delete(instance);
  }
}

/**
 * Express puts the app on `req.app` (a mounted sub-app has a `parent`); Fastify puts the
 * instance, or an encapsulated child created from it, on `request.server`.
 */
export function storageForRequest(req: any): Storage | undefined {
  const candidates: unknown[] = [];
  for (let app = req?.app; app && candidates.length < 16; app = app.parent) {
    candidates.push(app);
  }
  for (let server = req?.server; server && server !== Object.prototype; server = Object.getPrototypeOf(server)) {
    candidates.push(server);
  }

  for (const candidate of candidates) {
    const storage = typeof candidate === 'object' || typeof candidate === 'function' ? byServer.get(candidate as object) : undefined;
    if (storage) {
      return storage;
    }
  }

  return undefined;
}
