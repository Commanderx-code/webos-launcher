// Calls to webOS system services over the Luna bus, without LG's webOSTV.js.
window.Luna = (function () {
  'use strict';

  const TIMEOUT_MS = 5000;
  // A bridge that gets garbage-collected mid-call never answers, so keep each one until it does.
  const pending = new Set();

  function available() {
    return typeof window.PalmServiceBridge !== 'undefined';
  }

  function call(uri, params) {
    return new Promise((resolve, reject) => {
      if (!available()) {
        reject(new Error('not running on a webOS TV'));
        return;
      }
      const bridge = new window.PalmServiceBridge();
      pending.add(bridge);
      const timer = setTimeout(() => {
        pending.delete(bridge);
        reject(new Error('no answer from ' + uri));
      }, TIMEOUT_MS);

      bridge.onservicecallback = (raw) => {
        clearTimeout(timer);
        pending.delete(bridge);
        let res;
        try {
          res = JSON.parse(raw);
        } catch (e) {
          reject(e);
          return;
        }
        if (res.returnValue === false) {
          const err = new Error(res.errorText || 'call failed');
          err.response = res;
          reject(err);
        } else {
          resolve(res);
        }
      };
      bridge.call(uri, JSON.stringify(params || {}));
    });
  }

  function launch(id, params) {
    return call('luna://com.webos.applicationManager/launch', { id: id, params: params || {} });
  }

  // Stock TVs usually deny this to sideloaded apps; rooted ones allow it.
  function listLaunchPoints() {
    return call('luna://com.webos.applicationManager/listLaunchPoints', {});
  }

  function close(id) {
    return call('luna://com.webos.applicationManager/closeByAppId', { id: id });
  }

  // A root shell command through the Homebrew Channel's service; rooted TVs only.
  function exec(command) {
    return call('luna://org.webosbrew.hbchannel.service/exec', { command: command });
  }

  return { available: available, call: call, launch: launch, close: close, exec: exec, listLaunchPoints: listLaunchPoints };
})();
