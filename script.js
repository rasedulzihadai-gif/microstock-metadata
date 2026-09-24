/*!
 * Bootstrap — the page loads the modules in order, then this file starts the app.
 * (Kept as the single entry point referenced by index.html.)
 */
(function () {
  'use strict';

  function boot() {
    if (!window.MSMG || !window.MSMG.app) {
      console.error('MSMG modules failed to load — check the script tags in index.html.');
      return;
    }
    window.MSMG.app.init();
    if (window.MSMG.devMode) {
      console.info('Dev mode: the Mock (offline testing) provider is available in the provider list.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
