// The Underwriting pages are static pages of this site. Anything live (the
// desk's chat, live panels, the workbook download, the connector address)
// comes from the engine server, across origins. This is the one place that
// names it.
window.UW_API = 'https://hub.mjzou.com';
(function () {
  // Local preview only: localStorage.uwApi = 'http://127.0.0.1:8765' points the pages at a local engine server.
  try {
    var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && localStorage.getItem('uwApi');
    if (local) window.UW_API = local;
  } catch (e) {}
  // The page scripts ask for /api/... and /static/... as they did on the
  // engine server: the first goes to it, the second is the copy shipped here.
  var fetch0 = window.fetch;
  window.fetch = function (url, options) {
    if (typeof url === 'string') url = url.replace(/^\/api\//, window.UW_API + '/api/').replace(/^\/static\//, '/lab/underwriting/static/');
    return fetch0.call(window, url, options);
  };
})();
