(() => {
  'use strict';

  const addressInput = document.querySelector('#carAddress');
  const status = document.querySelector('#linkStatus');
  const statusText = document.querySelector('#statusText');
  const speedInput = document.querySelector('#speed');
  const speedValue = document.querySelector('#speedValue');
  const driveButtons = [...document.querySelectorAll('[data-key]')];
  let activeKey = '';
  let activePointerId = null;
  let heartbeat = 0;
  let requestInFlight = false;
  let requestQueue = Promise.resolve();

  addressInput.value = localStorage.getItem('rcCarAddress') || '192.168.4.1';

  function setStatus(message, ready = false) {
    statusText.textContent = message;
    status.classList.toggle('is-ready', ready);
  }

  function baseUrl() {
    const host = addressInput.value.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (!host || !/^[a-z\d.-]+(?::\d{1,5})?$/i.test(host)) {
      throw new Error('Enter a valid ESP8266 IP address.');
    }
    return `http://${host}`;
  }

  function sendCommand(key = activeKey, keepalive = false) {
    let root;
    try {
      root = baseUrl();
    } catch (error) {
      setStatus(error.message);
      return Promise.resolve();
    }

    const query = new URLSearchParams({ key, speed: speedInput.value, _: String(Date.now()) });
    const url = `${root}/drive?${query.toString()}`;
    const performRequest = () => {
      requestInFlight = true;
      return fetch(url, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        keepalive
      })
        .then(() => setStatus(key ? `Sending “${key}” · speed ${speedInput.value}` : 'Stop sent', true))
        .catch(() => setStatus('Car not reached · check Wi-Fi and address'))
        .finally(() => { requestInFlight = false; });
    };

    // Send one request at a time so a late movement command cannot follow STOP.
    const pending = requestQueue.then(performRequest, performRequest);
    requestQueue = pending.catch(() => {});
    return pending;
  }

  function stopMovement() {
    clearInterval(heartbeat);
    heartbeat = 0;
    activeKey = '';
    activePointerId = null;
    driveButtons.forEach(button => button.classList.remove('is-held'));
    return sendCommand('');
  }

  function startMovement(key, button, pointerId) {
    if (activeKey === key && activePointerId === pointerId) return;
    clearInterval(heartbeat);
    activeKey = key;
    activePointerId = pointerId;
    driveButtons.forEach(item => item.classList.toggle('is-held', item === button));
    sendCommand(key);

    // The sketch's failsafe is 600 ms; refresh a held command every 200 ms.
    heartbeat = setInterval(() => {
      if (activeKey && !requestInFlight) sendCommand(activeKey);
    }, 200);
  }

  driveButtons.forEach(button => {
    button.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      startMovement(button.dataset.key, button, event.pointerId);
    });
    const releasePointer = event => {
      if (activePointerId === event.pointerId) stopMovement();
    };
    button.addEventListener('pointerup', releasePointer);
    button.addEventListener('pointercancel', releasePointer);
    button.addEventListener('lostpointercapture', releasePointer);
    button.addEventListener('contextmenu', event => event.preventDefault());
  });

  window.addEventListener('pointerup', event => {
    if (activePointerId === event.pointerId) stopMovement();
  });
  window.addEventListener('blur', () => { if (activeKey) stopMovement(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && activeKey) stopMovement();
  });
  window.addEventListener('pagehide', () => {
    clearInterval(heartbeat);
    if (activeKey) sendCommand('', true);
  });

  document.querySelector('#stop').addEventListener('pointerdown', event => {
    event.preventDefault();
    stopMovement();
  });
  document.querySelector('#saveAddress').addEventListener('click', () => {
    try {
      const address = baseUrl().replace(/^http:\/\//i, '');
      addressInput.value = address;
      localStorage.setItem('rcCarAddress', address);
      stopMovement();
      setStatus('Address saved · stop sent', true);
    } catch (error) {
      setStatus(error.message);
    }
  });
  speedInput.addEventListener('input', () => {
    speedValue.value = speedInput.value;
    speedValue.textContent = speedInput.value;
    sendCommand(activeKey);
  });

  document.addEventListener('keydown', event => {
    if (event.target instanceof HTMLInputElement) return;
    const keys = {
      ArrowUp: 'f', w: 'f', W: 'f', ArrowDown: 'b', s: 'b', S: 'b',
      ArrowLeft: 'l', a: 'l', A: 'l', ArrowRight: 'r', d: 'r', D: 'r',
      q: 'gl', Q: 'gl', e: 'gr', E: 'gr'
    };
    if (event.code === 'Space') {
      event.preventDefault();
      stopMovement();
      return;
    }
    const key = keys[event.key];
    if (key) {
      event.preventDefault();
      startMovement(key, null, null);
    }
  });
  document.addEventListener('keyup', event => {
    if (activePointerId === null && activeKey) stopMovement();
  });

  document.querySelector('#stop').addEventListener('click', event => {
    // Pointer presses already stop immediately; keep click for keyboard activation.
    if (event.detail === 0) stopMovement();
  });
  speedValue.textContent = speedInput.value;
  setStatus('Ready · connect to College-RC-Car', false);
})();
