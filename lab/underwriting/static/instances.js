(function () {
  'use strict';

  /* Instance Layer v1 storage (docs/INSTANCE_LAYER.md §3): a small vanilla-JS
     promise wrapper over IndexedDB. Database `uw_hub` version 1 holds one
     object store `instances` keyed by `id` with indexes on model_id, entity,
     and updated_at — one store for every mounted model, because an instance's
     schema is its template's catalog, not the instance itself. This is the
     only client-side persistence on the demo page (web-storage APIs stay
     banned). All values written here are Instance JSON v1 documents assembled by
     demo.js from engine payloads — nothing is computed in this file. */

  const DB_NAME = 'uw_hub';
  const DB_VERSION = 1;
  const STORE_NAME = 'instances';

  let dbPromise = null;

  function openDatabase() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('model_id', 'model_id');
            store.createIndex('entity', 'entity');
            store.createIndex('updated_at', 'updated_at');
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
          dbPromise = null;
          reject(request.error || new Error('Instance storage could not open.'));
        };
      });
    }
    return dbPromise;
  }

  function withStore(mode, run) {
    return openDatabase().then((db) => new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        reject(request.error || new Error('Instance storage request failed.'));
      };
    }));
  }

  function save(instance) {
    return withStore('readwrite', (store) => store.put(instance))
      .then(() => instance);
  }

  function get(id) {
    return withStore('readonly', (store) => store.get(id));
  }

  function remove(id) {
    return withStore('readwrite', (store) => store.delete(id));
  }

  // Newest first. ISO 8601 updated_at strings order lexicographically, so
  // this is a string sort, not arithmetic on stored values.
  function listByModel(modelId) {
    return withStore('readonly', (store) => store.index('model_id').getAll(modelId))
      .then((rows) => (Array.isArray(rows) ? rows : []).slice().sort(
        (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')),
      ));
  }

  window.uwInstances = { save, get, remove, listByModel };
}());
