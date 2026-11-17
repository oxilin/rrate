// Runs inside the Degree Works page itself (not the extension sandbox).
// Watches the page's own network calls and forwards the audit JSON to the extension.
// It only reads responses the page already requested — it doesn't make new requests.
(() => {

  function forward(url, text) {
    if (!text || !text.includes('"blockArray"')) return;
    try {
      const body = JSON.parse(text);
      window.postMessage({ source: "rrate-dw", url, body }, window.location.origin);
    } catch (_) { /* not JSON */ }
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0].url;
      res.clone().text().then(t => forward(url, t)).catch(() => {});
    } catch (_) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener("load", () => {
      try {
        if (this.responseType === "" || this.responseType === "text") forward(String(url), this.responseText);
        else if (this.responseType === "json") forward(String(url), JSON.stringify(this.response));
      } catch (_) {}
    });
    return origOpen.call(this, method, url, ...rest);
  };
})();
