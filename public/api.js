// public/api.js — thin fetch wrapper shared by planner.js and couple.js.
const Api = (() => {
  let tokenGetter = () => null;
  function setTokenGetter(fn) { tokenGetter = fn; }

  async function call(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const t = tokenGetter();
    if (t) headers['Authorization'] = `Bearer ${t}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      const err = new Error('offline');
      err.offline = true;
      throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    setTokenGetter,
    get: (path) => call(path, { method: 'GET' }),
    post: (path, body) => call(path, { method: 'POST', body }),
    patch: (path, body) => call(path, { method: 'PATCH', body }),
    del: (path) => call(path, { method: 'DELETE' }),
  };
})();
