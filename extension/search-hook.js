// Runs inside the registration page itself (not the extension sandbox).
// Banner's class search loads results with XMLHttpRequest; this notes the URL of the most
// recent search so R'Rate can re-run the same search with all results at once.
// It only reads the URLs of requests the page already makes; it doesn't change them.
(() => {
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      const u = String(url);
      if (/\/searchResults\/searchResults\?/.test(u)) {
        this.addEventListener("load", () => {
          let total = null;
          try { total = JSON.parse(this.responseText).totalCount; } catch (_) {}
          window.postMessage({ source: "rrate-search", url: u, total }, window.location.origin);
        });
      }
    } catch (_) {}
    return origOpen.call(this, method, url, ...rest);
  };
})();
