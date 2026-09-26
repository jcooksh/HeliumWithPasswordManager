// Minimal in-memory stand-in for chrome.storage used by the unit tests.
function area() {
  let data = {};
  return {
    _data: () => data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    async clear() {
      data = {};
    },
  };
}

export function installChromeMock() {
  globalThis.chrome = { storage: { local: area(), session: area() } };
  return globalThis.chrome;
}
