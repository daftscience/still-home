(function () {
  'use strict';

  var initialFragment = window.location.hash;
  var scannedPairMatch = /^#pair=(\d{6})$/.exec(initialFragment);
  var pairingLinkPresent = initialFragment.indexOf('#pair') === 0;
  var scannedPairCode = scannedPairMatch ? scannedPairMatch[1] : '';
  if (pairingLinkPresent) {
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); }
    catch (_) { scannedPairCode = ''; }
  }
  initialFragment = '';
  scannedPairMatch = null;

  var SESSION_KEY = 'stillhome.phone.session';
  var MAX_FILE_SIZE = 150 * 1024 * 1024;
  var state = { token: '', expiresAt: 0, remembered: false, sessionGeneration: 0, recovery: null, starting: false, forgetting: false, config: null, apps: [], appDraft: [], appDirty: false, busy: false, pairing: false, upload: null, preparing: null, transferSerial: 0, file: null, searchId: 0, connected: false, librarySignature: '', editor: null };
  var installPrompt = null;
  var mediaActions;
  function wallpaperAction(action,entry){
    if(!mediaActions)mediaActions=window.StillHomeMediaActions.create({
      revision:function(){return state.config.revision;},request:request,
      busy:function(){return state.busy||state.upload||state.preparing||state.editor;},
      config:function(config){acceptConfig(config,false);},notify:notice,
      closed:function(id,origin){var row=document.querySelector('[data-wallpaper-id="'+id+'"]');var target=row&&row.querySelector('button:not(:disabled)');if(target)target.focus();else $('refresh-button').focus();}
    });
    mediaActions.open(action,entry);
  }
  var $ = function (id) { return document.getElementById(id); };
  var appearanceRanges = [
    { field: 'kenBurnsSpeed', id: 'ken-burns-speed', defaultValue: 1, message: 'Photo motion speed saved.' },
    { field: 'clockScale', id: 'clock-scale', defaultValue: 1, message: 'Clock size saved.' },
    { field: 'dateScale', id: 'date-scale', defaultValue: 1, message: 'Date size saved.' },
    { field: 'weatherScale', id: 'weather-scale', defaultValue: 1, message: 'Weather size saved.' },
    { field: 'textShade', id: 'text-shade', defaultValue: 0, message: 'Text shadow saved.' }
  ];
  var controls = ['refresh-button', 'wallpaper-file', 'upload-button', 'clear-file-button', 'wallpaper-dim', 'ken-burns', 'launch-at-start', 'reset-wallpaper-button', 'current-focal-button', 'location-query', 'location-search-button', 'clear-location-button', 'temperature-unit', 'clock-format', 'default-apps-button', 'save-apps-button'].concat(appearanceRanges.map(function (setting) { return setting.id; }));

  function notice(message, isError) {
    $('notice').textContent = message || '';
    $('notice').className = 'notice' + (isError ? ' error' : '');
    $('notice').hidden = !message;
  }

  function connection(online) {
    state.connected = online;
    $('connection-label').textContent = online ? 'Connected to your TV' : 'TV connection unavailable';
    $('connection-label').parentElement.classList.toggle('offline', !online);
  }

  function storeSession() {
    // Only the short-lived bearer lives in JavaScript storage. The remembered
    // credential is an HttpOnly cookie managed exclusively by the TV service.
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: state.token, expiresAt: state.expiresAt, remembered: state.remembered })); } catch (_) { /* The session still works until this page closes. */ }
  }

  function clearSession(message) {
    if(mediaActions)mediaActions.close();
    state.sessionGeneration += 1;
    state.recovery = null;
    closeFocal(true);
    state.token = '';
    state.expiresAt = 0;
    state.remembered = false;
    state.config = null;
    state.apps = [];
    state.appDraft = [];
    state.appDirty = false;
    state.librarySignature = '';
    state.searchId += 1;
    cancelTransfer(false);
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* Storage may be disabled. */ }
    $('settings-view').hidden = true;
    $('pair-view').hidden = false;
    $('pair-code').value = '';
    $('reconnect-button').hidden = true;
    clearFile();
    notice(message || '', Boolean(message));
  }

  function expireSession() {
    clearSession('Your connection expired or Still Home was reset. Choose “Show pairing QR code” under Pairing in your TV’s Still Home Settings and pair with a new code.');
  }

  function makeError(message, status, body) {
    var error = new Error(message);
    error.status = status;
    error.body = body;
    return error;
  }

  function rawRequest(path, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var generation = state.sessionGeneration;
      xhr.open(options.method || 'GET', path, true);
      xhr.timeout = 20000;
      if (!options.noAuth && state.token) xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      if (options.body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onload = function () {
        if (generation !== state.sessionGeneration) { reject(makeError('Connection changed.', 499)); return; }
        var body;
        try { body = JSON.parse(xhr.responseText); } catch (_) { reject(makeError('The TV returned an unreadable response. Try refreshing.', xhr.status)); return; }
        if (xhr.status >= 200 && xhr.status < 300) {
          connection(true);
          resolve(body);
        } else {
          reject(makeError(body.error || 'The request could not be completed.', xhr.status, body));
        }
      };
      xhr.onerror = function () { connection(false); reject(makeError('Could not reach the TV. Check that it is on and your phone is on the same Wi-Fi.')); };
      xhr.ontimeout = function () { connection(false); reject(makeError('The TV took too long to respond. Please try again.')); };
      xhr.onabort = function () { reject(makeError('The request was canceled.')); };
      xhr.send(options.body === undefined ? null : JSON.stringify(options.body));
    });
  }

  function acceptSession(body) {
    if (!body || typeof body.token !== 'string' || !body.token || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) throw makeError('The TV did not return a usable connection. Please try again.');
    state.token = body.token;
    state.expiresAt = body.expiresAt;
    state.remembered = body.remembered === true;
    storeSession();
    updateSessionControls();
  }

  function recoverSession() {
    if (state.recovery) return state.recovery;
    var recovery = rawRequest('/api/session', { method: 'POST', body: {}, noAuth: true }).then(acceptSession);
    state.recovery = recovery;
    function release() { if (state.recovery === recovery) state.recovery = null; }
    recovery.then(release, release);
    return recovery;
  }

  function request(path, options, retried) {
    options = options || {};
    if (options.noAuth) return rawRequest(path, options);
    var generation = state.sessionGeneration;
    var requestToken = state.token;
    function renewAndRetry() {
      return recoverSession().then(function () {
        if (generation !== state.sessionGeneration) throw makeError('Connection changed.', 499);
        return request(path, options, true);
      }).catch(function (error) {
        if (error.status === 401 && generation === state.sessionGeneration) expireSession();
        throw error;
      });
    }
    if (!retried && state.expiresAt && state.expiresAt <= Date.now()) return renewAndRetry();
    return rawRequest(path, options).catch(function (error) {
      if (error.status !== 401 || generation !== state.sessionGeneration) throw error;
      if (retried) { expireSession(); throw error; }
      if (requestToken !== state.token) return request(path, options, true);
      return renewAndRetry();
    });
  }

  function deviceName() {
    if (/iPhone|iPod/.test(navigator.userAgent)) return 'iPhone';
    if (/iPad/.test(navigator.userAgent) || /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return 'iPad';
    return /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser';
  }

  function updateSessionControls() {
    $('session-note').textContent = state.remembered ? 'This phone is remembered. Open Still Home again to reconnect on your home Wi-Fi.' : 'This tab is connected for 30 minutes. Remember this phone to reconnect when you open it again.';
    $('remember-button').hidden = state.remembered;
    $('remember-button').disabled = state.busy || state.forgetting || Boolean(state.upload) || Boolean(state.preparing);
    $('forget-button').hidden = !state.remembered;
    $('forget-button').disabled = state.forgetting;
    $('disconnect-button').disabled = state.forgetting;
    var standalone = navigator.standalone === true || window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
    $('install-intro').textContent = standalone ? 'You are using Still Home from your Home Screen.' : 'Add a Still Home icon to open this companion from your phone.';
    $('install-button').hidden = !installPrompt || standalone;
    var name = deviceName();
    $('install-iphone').hidden = name === 'Android phone';
    $('install-android').hidden = name === 'iPhone' || name === 'iPad';
    $('install-pairing-note').textContent = name === 'Android phone' ? 'Remember this phone before adding the icon. If the Home Screen app asks to pair once, use a fresh code from your TV.' : 'Remember this phone before adding the icon. On iOS 17.2 or later, Safari can carry the connection into the new Home Screen app. If it asks to pair once, use a fresh code from your TV.';
  }

  function handleError(error) {
    if (error.status === 401 || error.status === 499) return;
    if (error.status === 409 && error.body && error.body.config) {
      acceptConfig(error.body.config, false);
      notice('Settings changed on your TV or another phone. The latest settings are loaded and your unsaved drafts are kept. Review your change before saving again.', true);
      return;
    }
    notice(error.message || 'Something went wrong. Please try again.', true);
  }

  function setBusy(value) {
    state.busy = value;
    updateControls();
  }

  function updateControls() {
    var disabled = state.busy || Boolean(state.upload) || Boolean(state.preparing);
    controls.forEach(function (id) { $(id).disabled = disabled; });
    $('upload-button').disabled = disabled || !state.file;
    $('save-apps-button').disabled = disabled || !state.appDirty;
    $('reset-wallpaper-button').disabled = disabled || !state.config || !state.config.wallpaper;
    document.querySelector('.file-picker').classList.toggle('disabled', disabled);
    document.querySelectorAll('#selected-apps button, #available-apps input, #location-results button, #wallpaper-library button').forEach(function (control) {
      control.disabled = disabled || control.dataset.unavailable === 'true';
    });
    updateFocalControls();
    updateSessionControls();
  }

  function sizeLabel(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  }

  function effectiveApps(config) {
    return config.appIds === null ? state.apps.slice(0, 6).map(function (app) { return app.id; }) : (config.appIds || []).slice();
  }

  function acceptConfig(config, resetDraft) {
    if (!config || !Number.isInteger(config.revision)) throw makeError('The TV returned incomplete settings. Try refreshing.');
    if (state.config && config.revision < state.config.revision) return;
    state.config = config;
    var wallpaper = config.wallpaper;
    $('current-focal-button').hidden = Boolean(wallpaper && wallpaper.kind === 'video');
    $('wallpaper-name').textContent = wallpaper ? wallpaper.name : 'Default landscape';
    $('wallpaper-detail').textContent = wallpaper ? (wallpaper.kind === 'video' ? 'Looping video' : 'Photo') + (wallpaper.width && wallpaper.height ? ' · ' + wallpaper.width + ' × ' + wallpaper.height : '') + ' · ' + sizeLabel(wallpaper.size) : 'Still Home wallpaper';
    $('wallpaper-dim').value = String(Math.round(config.dim * 100));
    $('dim-value').textContent = Math.round(config.dim * 100) + '%';
    $('ken-burns').checked = Boolean(config.kenBurns);
    $('launch-at-start').checked = Boolean(config.launchAtStart);
    $('ken-burns-help').textContent = wallpaper && wallpaper.kind === 'video' ? 'Your wallpaper is a video, so it keeps its own motion. This preference will apply when you choose a photo.' : 'A gentle Ken Burns effect for photo wallpapers. Videos keep their own motion.';
    $('temperature-unit').value = config.temperatureUnit;
    $('clock-format').value = config.clock24 ? '24' : '12';
    appearanceRanges.forEach(function (setting) {
      var value = typeof config[setting.field] === 'number' ? config[setting.field] : setting.defaultValue;
      var percent = Math.round(value * 100);
      $(setting.id).value = String(percent);
      $(setting.id + '-value').textContent = percent + '%';
    });
    $('current-location').textContent = config.location ? 'Weather for ' + config.location.name : 'Choose a location to show the weather.';
    $('clear-location-button').hidden = !config.location;
    if (resetDraft || !state.appDirty) {
      state.appDraft = effectiveApps(config);
      state.appDirty = false;
      renderApps();
    }
    renderLibrary();
    syncFocalAvailability();
    updateControls();
  }

  function loadState(resetDraft) {
    return request('/api/state').then(function (body) {
      if (!body.config || !Array.isArray(body.apps)) throw makeError('The TV returned incomplete settings. Try refreshing.');
      state.apps = body.apps;
      acceptConfig(body.config, resetDraft);
      $('pair-view').hidden = true;
      $('settings-view').hidden = false;
    });
  }

  function patch(fields, successMessage, resetDraft) {
    if (!state.config || state.busy || state.upload || state.preparing) return Promise.resolve(false);
    var payload = { revision: state.config.revision };
    Object.keys(fields).forEach(function (key) { payload[key] = fields[key]; });
    setBusy(true);
    return request('/api/config', { method: 'PATCH', body: payload }).then(function (body) {
      acceptConfig(body.config, Boolean(resetDraft));
      notice(successMessage || 'Settings saved.');
      return true;
    }).catch(function (error) {
      if (state.config && error.status !== 409) acceptConfig(state.config, false);
      handleError(error);
      return false;
    }).then(function (result) { setBusy(false); return result; });
  }

  function libraryEntries() {
    if (!state.config) return [];
    var entries = [{ id: 'default', name: 'Included wallpaper', kind: 'image', width: 1920, height: 902, focalPoint: state.config.defaultFocalPoint || null }];
    var seen = { default: true };
    (state.config.wallpaperLibrary || []).forEach(function (entry) {
      if (!entry || !/^[a-f0-9]{32}$/.test(entry.id) || seen[entry.id]) return;
      seen[entry.id] = true;
      entries.push(entry);
    });
    if (state.config.wallpaper && !seen[state.config.wallpaper.id]) entries.push(state.config.wallpaper);
    return entries;
  }

  function libraryEntry(id) {
    return libraryEntries().filter(function (entry) { return entry.id === id; })[0] || null;
  }

  function renderLibrary() {
    var entries = libraryEntries();
    var currentId = state.config && state.config.wallpaper ? state.config.wallpaper.id : 'default';
    var signature = JSON.stringify([entries, currentId]);
    if (signature === state.librarySignature) return;
    state.librarySignature = signature;
    var list = $('wallpaper-library');
    var scroll = list.scrollTop;
    list.textContent = '';
    entries.forEach(function (entry) {
      var row = document.createElement('li');
      row.className = 'wallpaper-library-row' + (entry.id === currentId ? ' current' : '');
      row.dataset.wallpaperId = entry.id;
      var heading = document.createElement('div'); heading.className = 'wallpaper-library-title';
      var symbol = document.createElement('span'); symbol.className = 'wallpaper-library-symbol'; symbol.textContent = entry.kind === 'video' ? '▷' : '▧'; symbol.setAttribute('aria-hidden', 'true'); heading.appendChild(symbol);
      var name = document.createElement('strong'); name.textContent = entry.name; heading.appendChild(name); row.appendChild(heading);
      var meta = document.createElement('span'); meta.className = 'fine-print';
      meta.textContent = (entry.kind === 'video' ? 'Video' : 'Photo') + (entry.width && entry.height ? ' · ' + entry.width + ' × ' + entry.height : '') + (entry.size ? ' · ' + sizeLabel(entry.size) : '') + (entry.focalPoint ? ' · Focal point saved' : ''); row.appendChild(meta);
      var actions = document.createElement('div'); actions.className = 'wallpaper-library-actions';
      var choose = document.createElement('button'); choose.type = 'button'; choose.className = 'text-button'; choose.textContent = entry.id === currentId ? 'Selected' : 'Use wallpaper'; choose.setAttribute('aria-label', (entry.id === currentId ? 'Selected wallpaper: ' : 'Use wallpaper: ') + entry.name); choose.dataset.unavailable = entry.id === currentId ? 'true' : 'false';
      choose.addEventListener('click', function () { selectWallpaper(entry.id); }); actions.appendChild(choose);
      if (entry.kind === 'image') {
        var edit = document.createElement('button'); edit.type = 'button'; edit.className = 'text-button'; edit.textContent = 'Set focal point'; edit.setAttribute('aria-label', 'Set focal point for ' + entry.name);
        edit.addEventListener('click', function () { openFocal(entry.id); }); actions.appendChild(edit);
      }
      if(entry.id!=='default')['rename','delete'].forEach(function(action){
        var control=document.createElement('button');control.type='button';control.className='text-button';control.textContent=action==='rename'?'Rename':'Delete';control.dataset.action=action;control.setAttribute('aria-label',(action==='rename'?'Rename ':'Delete ')+entry.name);
        control.addEventListener('click',function(){wallpaperAction(action,entry);});actions.appendChild(control);
      });
      row.appendChild(actions); list.appendChild(row);
    });
    list.scrollTop = scroll;
    $('wallpaper-library-count').textContent = entries.length + (entries.length === 1 ? ' wallpaper' : ' wallpapers');
  }

  function selectWallpaper(id) {
    if (!state.config || state.busy || state.upload || state.preparing || state.editor) return;
    if (!libraryEntry(id)) { notice('That wallpaper is no longer in the library. Refresh settings and try again.', true); return; }
    setBusy(true);
    request('/api/wallpapers/select', { method: 'POST', body: { revision: state.config.revision, id: id } }).then(function (body) {
      acceptConfig(body.config, false); notice('Wallpaper selected. Your other wallpapers are still in the library.');
    }).catch(handleError).then(function () { setBusy(false); });
  }

  function copyPoint(point) { return point ? { x: point.x, y: point.y } : null; }
  function samePoint(a, b) { return a === null && b === null || Boolean(a && b && a.x === b.x && a.y === b.y); }

  function focalNotice(message, isError) {
    $('focal-notice').textContent = message;
    $('focal-notice').className = 'focal-notice' + (isError ? ' error' : '');
  }

  function updateFocalControls() {
    var editor = state.editor;
    var disabled = !editor || !editor.loaded || editor.saving || editor.missing || state.busy;
    ['focal-x', 'focal-y', 'focal-zoom', 'focal-reset-button'].forEach(function (id) { $(id).disabled = disabled; });
    $('focal-save-button').disabled = disabled || !editor || !editor.dirty;
    ['focal-close-button', 'focal-cancel-button'].forEach(function (id) { $(id).disabled = Boolean(editor && editor.saving); });
  }

  function syncFocalAvailability() {
    var editor = state.editor;
    if (!editor) return;
    var entry = libraryEntry(editor.id);
    editor.missing = !entry || entry.kind !== 'image';
    if (editor.missing) focalNotice('This photo is no longer available in the library. Your draft is kept here, but it cannot be saved to another photo.', true);
    else if (!editor.saving && !samePoint(entry.focalPoint || null, editor.initialPoint)) focalNotice('This photo was edited elsewhere. Your focal point draft is kept. Review it before saving again.', true);
  }

  function closeFocal(force) {
    var editor = state.editor;
    if (editor && editor.saving && !force) return;
    state.editor = null;
    var image = $('focal-image'); image.onload = null; image.onerror = null; image.removeAttribute('src');
    $('focal-dialog').hidden = true;
    document.body.classList.remove('focal-open');
    $('focal-crosshair').hidden = true; $('focal-crop-outline').hidden = true;
    $('focal-preview').width = 1; $('focal-preview').height = 1;
    if (editor && editor.restoreFocus && document.contains(editor.restoreFocus)) editor.restoreFocus.focus({ preventScroll: true });
    updateFocalControls();
  }

  function openFocal(id) {
    if (!state.config || state.busy || state.upload || state.preparing) return;
    var entry = libraryEntry(id);
    if (!entry || entry.kind !== 'image') { notice('Choose a saved photo to set a focal point.', true); return; }
    if (!window.StillHomeFocal) { notice('The framing editor could not load. Refresh the page and try again.', true); return; }
    closeFocal(true);
    var editor = { id: id, name: entry.name, point: copyPoint(entry.focalPoint || null), initialPoint: copyPoint(entry.focalPoint || null), baseRevision: state.config.revision, dirty: false, forceDirty: false, loaded: false, saving: false, missing: false, pointerId: null, restoreFocus: document.activeElement };
    state.editor = editor;
    $('focal-photo-name').textContent = entry.name;
    $('focal-dialog').hidden = false; document.body.classList.add('focal-open');
    $('focal-zoom').value = '100'; $('focal-zoom-value').textContent = '100%';
    $('focal-preview').width = 640; $('focal-preview').height = 360;
    focalNotice('Loading photo…'); updateFocalControls();
    var image = $('focal-image');
    image.onload = function () {
      if (state.editor !== editor) return;
      editor.width = image.naturalWidth; editor.height = image.naturalHeight;
      if (!editor.width || !editor.height) { focalNotice('This photo could not be read. Close the editor and try again.', true); return; }
      editor.loaded = true;
      focalNotice('Tap the photo or use the sliders. Changes are only applied when you save.');
      renderFocal(); updateFocalControls();
    };
    var mediaToken = state.token;
    var retriedMedia = false;
    image.onerror = function () {
      if (state.editor !== editor) return;
      function failed() {
        if (state.editor !== editor) return;
        focalNotice('This photo could not load. Check the TV connection; it may need to be uploaded again as a resized copy. Close the editor and try again.', true);
        updateFocalControls();
      }
      if (retriedMedia) { failed(); return; }
      retriedMedia = true;
      // Media elements cannot attach headers or report a 401. Validate the
      // session through the API before retrying the same photo once.
      request('/api/state').then(function () {
        if (state.editor !== editor) return;
        if (mediaToken === state.token) { failed(); return; }
        image.src = '/media/library?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(state.token);
      }).catch(function (error) { handleError(error); failed(); });
    };
    image.src = '/media/library?id=' + encodeURIComponent(id) + '&token=' + encodeURIComponent(state.token);
    $('focal-close-button').focus();
  }

  function renderFocal() {
    var editor = state.editor;
    if (!editor || !editor.loaded) return;
    var point = editor.point;
    $('focal-x').value = String(Math.round((point ? point.x : 0.5) * 1000));
    $('focal-y').value = String(Math.round((point ? point.y : 0.5) * 1000));
    $('focal-x-value').textContent = ((point ? point.x : 0.5) * 100).toFixed(1) + '%';
    $('focal-y-value').textContent = ((point ? point.y : 0.5) * 100).toFixed(1) + '%';
    var zoom = Number($('focal-zoom').value) / 100;
    $('focal-zoom-value').textContent = Math.round(zoom * 100) + '%';
    var frame = window.StillHomeFocal.computeFrame({ imageWidth: editor.width, imageHeight: editor.height, viewportWidth: 640, viewportHeight: 360, point: point, zoom: zoom });
    var rect = $('focal-surface').getBoundingClientRect();
    var contained = window.StillHomeFocal.containRect({ imageWidth: editor.width, imageHeight: editor.height, viewportWidth: rect.width, viewportHeight: rect.height });
    var crop = $('focal-crop-outline');
    crop.style.left = (contained.left - frame.left / frame.scale * contained.scale) + 'px';
    crop.style.top = (contained.top - frame.top / frame.scale * contained.scale) + 'px';
    crop.style.width = (640 / frame.scale * contained.scale) + 'px';
    crop.style.height = (360 / frame.scale * contained.scale) + 'px'; crop.hidden = false;
    var crosshair = $('focal-crosshair'); crosshair.hidden = !point;
    if (point) { crosshair.style.left = (contained.left + point.x * contained.width) + 'px'; crosshair.style.top = (contained.top + point.y * contained.height) + 'px'; }
    var canvas = $('focal-preview'); var context = canvas.getContext('2d');
    context.clearRect(0, 0, 640, 360); context.drawImage($('focal-image'), frame.left, frame.top, frame.width, frame.height);
    if (point) { context.strokeStyle = '#fff'; context.lineWidth = 2; context.beginPath(); context.arc(frame.anchor.x, frame.anchor.y, 7, 0, Math.PI * 2); context.stroke(); }
    canvas.dataset.anchorX = String(frame.anchor.x); canvas.dataset.anchorY = String(frame.anchor.y);
    $('focal-anchor-status').textContent = frame.framingLabel;
    editor.dirty = editor.forceDirty || !samePoint(editor.point, editor.initialPoint);
    updateFocalControls();
  }

  function updateFocalPoint(point) {
    var editor = state.editor;
    if (!editor || !editor.loaded || editor.saving || editor.missing || state.busy) return;
    editor.forceDirty = false; editor.point = copyPoint(point); renderFocal();
  }

  function focalPointer(event) {
    var editor = state.editor;
    if (!editor || !editor.loaded || editor.saving || editor.missing) return;
    var point = window.StillHomeFocal.pointFromClient({ rect: $('focal-surface').getBoundingClientRect(), imageWidth: editor.width, imageHeight: editor.height, clientX: event.clientX, clientY: event.clientY });
    if (point) updateFocalPoint(point);
  }

  function saveFocal() {
    var editor = state.editor;
    if (!editor || !editor.loaded || !editor.dirty || editor.saving || editor.missing || state.busy) return;
    if (!libraryEntry(editor.id)) { syncFocalAvailability(); updateFocalControls(); return; }
    var payload = { revision: editor.baseRevision, id: editor.id, focalPoint: copyPoint(editor.point) };
    editor.saving = true; setBusy(true); focalNotice('Saving focal point…');
    request('/api/wallpapers/focal', { method: 'POST', body: payload }).then(function (body) {
      acceptConfig(body.config, false);
      editor.saving = false;
      setBusy(false);
      if (state.editor === editor) closeFocal(true);
      notice('Framing saved for ' + editor.name + '.');
    }).catch(function (error) {
      if (state.editor !== editor) { handleError(error); return; }
      if (error.status === 409 && error.body && error.body.config) {
        acceptConfig(error.body.config, false);
        editor.baseRevision = error.body.config.revision;
        focalNotice('Settings changed elsewhere. Your focal point draft is kept. Review it, then select Save focal point again to apply it.', true);
      } else {
        handleError(error);
        if (state.editor === editor) focalNotice(error.message || 'The focal point could not be saved. Your draft is still here.', true);
      }
    }).then(function () { editor.saving = false; setBusy(false); });
  }

  function appIcon(app) {
    var fallback = document.createElement('span');
    fallback.className = 'app-initials';
    fallback.setAttribute('aria-hidden', 'true');
    fallback.textContent = app.title.trim().split(/\s+/).map(function (part) { return part.charAt(0); }).slice(0, 2).join('').toUpperCase() || 'TV';
    if (!app.icon || app.icon.indexOf('/api/icon?') !== 0) return fallback;
    var img = document.createElement('img');
    img.className = 'app-icon';
    img.alt = '';
    img.loading = 'lazy';
    img.src = app.icon + '&token=' + encodeURIComponent(state.token);
    img.onerror = function () { if (img.parentNode) img.parentNode.replaceChild(fallback, img); };
    return img;
  }

  function updateDirty() {
    state.appDirty = JSON.stringify(state.appDraft) !== JSON.stringify(effectiveApps(state.config));
    $('apps-save-note').textContent = state.appDirty ? 'You have unsaved app changes.' : 'Your app selection is saved.';
    updateControls();
  }

  function appAction(label, text, unavailable, action) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button' + (text === '×' ? ' remove' : '');
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.unavailable = unavailable ? 'true' : 'false';
    button.disabled = unavailable;
    button.addEventListener('click', action);
    return button;
  }

  function renderApps() {
    var selected = $('selected-apps');
    var available = $('available-apps');
    selected.textContent = '';
    available.textContent = '';
    state.appDraft.forEach(function (id, index) {
      var app = state.apps.filter(function (item) { return item.id === id; })[0] || { id: id, title: 'Unavailable app (' + id + ')' };
      var row = document.createElement('li');
      row.className = 'selected-app';
      var number = document.createElement('span');
      number.className = 'app-number';
      number.textContent = String(index + 1).padStart(2, '0');
      row.appendChild(number);
      row.appendChild(appIcon(app));
      var title = document.createElement('span');
      title.className = 'app-title';
      title.textContent = app.title;
      row.appendChild(title);
      var actions = document.createElement('div');
      actions.className = 'app-actions';
      actions.appendChild(appAction('Move ' + app.title + ' up', '↑', index === 0, function () {
        var previous = state.appDraft[index - 1];
        state.appDraft[index - 1] = id;
        state.appDraft[index] = previous;
        renderApps();
        focusAppAction(index - 1, 0);
      }));
      actions.appendChild(appAction('Move ' + app.title + ' down', '↓', index === state.appDraft.length - 1, function () {
        var next = state.appDraft[index + 1];
        state.appDraft[index + 1] = id;
        state.appDraft[index] = next;
        renderApps();
        focusAppAction(index + 1, 1);
      }));
      actions.appendChild(appAction('Remove ' + app.title + ' from Home', '×', false, function () {
        state.appDraft.splice(index, 1);
        renderApps();
        focusAppAction(Math.min(index, state.appDraft.length - 1), 2);
      }));
      row.appendChild(actions);
      selected.appendChild(row);
    });
    state.apps.forEach(function (app) {
      var row = document.createElement('label');
      row.className = 'available-app';
      row.appendChild(appIcon(app));
      var title = document.createElement('span');
      title.className = 'app-title';
      title.textContent = app.title;
      row.appendChild(title);
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.appDraft.indexOf(app.id) !== -1;
      checkbox.setAttribute('aria-label', 'Show ' + app.title + ' on Home');
      checkbox.addEventListener('change', function () {
        var listScroll = available.scrollTop;
        var appIndex = state.apps.indexOf(app);
        if (checkbox.checked) state.appDraft.push(app.id);
        else state.appDraft = state.appDraft.filter(function (id) { return id !== app.id; });
        renderApps();
        available.scrollTop = listScroll;
        var replacement = available.querySelectorAll('input')[appIndex];
        if (replacement) replacement.focus({ preventScroll: true });
      });
      row.appendChild(checkbox);
      available.appendChild(row);
    });
    $('selected-count').textContent = state.appDraft.length + (state.appDraft.length === 1 ? ' app' : ' apps');
    $('selected-apps-empty').hidden = state.appDraft.length > 0;
    $('available-apps-empty').hidden = state.apps.length > 0;
    updateDirty();
  }

  function focusAppAction(index, action) {
    var rows = $('selected-apps').children;
    if (index < 0 || !rows[index]) return;
    var button = rows[index].querySelectorAll('button')[action];
    if (button && !button.disabled) button.focus({ preventScroll: true });
  }

  function clearFile() {
    cancelTransfer(false);
    state.file = null;
    $('wallpaper-file').value = '';
    $('selected-file').hidden = true;
    $('selected-file-name').textContent = '';
    $('selected-file-size').textContent = '';
    updateControls();
  }

  function cancelTransfer(announce) {
    var wasPreparing = Boolean(state.preparing);
    var wasUploading = Boolean(state.upload);
    state.transferSerial += 1;
    if (state.preparing) state.preparing.canceled = true;
    state.preparing = null;
    var xhr = state.upload;
    state.upload = null;
    if (xhr) xhr.abort();
    $('upload-status').hidden = true;
    updateControls();
    if (announce && (wasPreparing || wasUploading)) notice(wasPreparing ? 'Photo preparation canceled. Nothing was uploaded.' : 'Upload canceled. Refresh settings if it had already finished transferring.');
  }

  function currentTransfer(job) {
    return !job.canceled && job.id === state.transferSerial && job.generation === state.sessionGeneration && job.file === state.file;
  }

  function uploadFile() {
    if (!state.file || state.busy || state.upload || state.preparing) return;
    var job = { id: ++state.transferSerial, generation: state.sessionGeneration, file: state.file, canceled: false, retried: false };
    notice('');
    if (/\.mp4$/i.test(job.file.name)) {
      startUpload({ blob: job.file, name: job.file.name }, job);
      return;
    }
    state.preparing = job;
    $('upload-status').hidden = false;
    $('upload-progress').removeAttribute('value');
    $('upload-percent').textContent = '';
    $('upload-label').textContent = 'Preparing photo…';
    $('cancel-upload-button').textContent = 'Cancel preparation';
    $('cancel-upload-button').disabled = false;
    updateControls();
    Promise.resolve().then(function () {
      if (!window.StillImagePrepare) throw new Error('Photo preparation could not load. Refresh this page and try again.');
      return window.StillImagePrepare.prepare(job.file, { isCanceled: function () { return !currentTransfer(job); } });
    }).then(function (prepared) {
      if (!currentTransfer(job)) return;
      $('selected-file-size').textContent = 'Original ' + sizeLabel(job.file.size) + ' → TV copy ' + sizeLabel(prepared.blob.size) + ' · ' + prepared.width + ' × ' + prepared.height;
      startUpload(prepared, job);
    }).catch(function (error) {
      if (!currentTransfer(job)) return;
      state.preparing = null;
      $('upload-status').hidden = true;
      updateControls();
      notice(error.name === 'AbortError' ? 'Photo preparation canceled. Nothing was uploaded.' : (error.message || 'This photo could not be prepared.') + ' Nothing was uploaded.', error.name !== 'AbortError');
    });
  }

  function renewUpload(prepared, job) {
    state.upload = null;
    state.preparing = job;
    job.retried = true;
    $('upload-label').textContent = 'Reconnecting before upload…';
    $('upload-progress').removeAttribute('value');
    $('upload-percent').textContent = '';
    updateControls();
    recoverSession().then(function () {
      if (currentTransfer(job)) startUpload(prepared, job);
    }).catch(function (error) {
      if (!currentTransfer(job)) return;
      state.preparing = null;
      $('upload-status').hidden = true;
      updateControls();
      if (error.status === 401) expireSession();
      else handleError(error);
    });
  }

  function startUpload(prepared, job) {
    if (!currentTransfer(job)) return;
    if (!job.retried && state.expiresAt && state.expiresAt <= Date.now()) { renewUpload(prepared, job); return; }
    var xhr = new XMLHttpRequest();
    var sessionToken = state.token;
    state.preparing = null;
    state.upload = xhr;
    $('upload-status').hidden = false;
    $('upload-progress').value = 0;
    $('upload-percent').textContent = '0%';
    $('upload-label').textContent = 'Uploading…';
    $('cancel-upload-button').textContent = 'Cancel upload';
    $('cancel-upload-button').disabled = false;
    notice('');
    updateControls();
    xhr.open('POST', '/api/upload?name=' + encodeURIComponent(prepared.name), true);
    xhr.timeout = 10 * 60 * 1000;
    xhr.setRequestHeader('Authorization', 'Bearer ' + sessionToken);
    xhr.setRequestHeader('Content-Type', prepared.blob.type || 'application/octet-stream');
    xhr.upload.onprogress = function (event) {
      if (!currentTransfer(job)) return;
      if (!event.lengthComputable) {
        $('upload-progress').removeAttribute('value');
        $('upload-percent').textContent = sizeLabel(event.loaded);
        return;
      }
      var percentage = Math.min(100, Math.round(event.loaded / event.total * 100));
      $('upload-progress').value = percentage;
      $('upload-percent').textContent = percentage + '%';
      if (percentage === 100) $('upload-label').textContent = 'Checking and setting wallpaper…';
    };
    function finish() {
      if (!currentTransfer(job)) return;
      state.upload = null;
      $('upload-status').hidden = true;
      updateControls();
    }
    xhr.onload = function () {
      if (!currentTransfer(job)) return;
      finish();
      var body;
      try { body = JSON.parse(xhr.responseText); } catch (_) { notice('The TV returned an unreadable upload response. Refresh settings to check whether your wallpaper changed.', true); return; }
      if (xhr.status >= 200 && xhr.status < 300 && body.config) {
        connection(true);
        acceptConfig(body.config, false);
        clearFile();
        notice(prepared.width ? 'Photo uploaded as a ' + prepared.width + ' × ' + prepared.height + ' TV copy (' + sizeLabel(prepared.blob.size) + '). Your original is unchanged.' : 'Wallpaper uploaded and set. It will appear in Still Home on your TV.');
      } else if (xhr.status === 401) {
        if (job.retried) expireSession();
        else { $('upload-status').hidden = false; renewUpload(prepared, job); }
      } else {
        handleError(makeError(body.error || 'Upload failed. Your existing wallpaper is still available.', xhr.status, body));
      }
    };
    xhr.onerror = function () { if (!currentTransfer(job)) return; finish(); connection(false); notice('The upload lost its connection. Check your Wi-Fi and refresh settings before trying again.', true); };
    xhr.ontimeout = function () { if (!currentTransfer(job)) return; finish(); notice('The upload timed out. Refresh settings to check the wallpaper, then try a smaller file.', true); };
    xhr.onabort = function () { if (!currentTransfer(job)) return; finish(); notice('Upload canceled. Refresh settings if it had already finished transferring.'); };
    xhr.send(prepared.blob);
  }

  function pairWithCode(code, remember) {
    if (state.pairing || state.starting) return;
    if (!/^\d{6}$/.test(code)) { notice('Enter the six-digit code shown on your TV.', true); return; }
    state.pairing = true;
    $('pair-button').disabled = true;
    $('pair-code').disabled = true;
    $('remember-phone').disabled = true;
    $('pair-button').textContent = 'Connecting…';
    notice('Connecting to your TV…');
    request('/api/pair', { method: 'POST', body: { code: code, remember: remember === true, name: deviceName() }, noAuth: true }).then(function (body) {
      acceptSession(body);
      return loadState(true);
    }).then(function () { $('pair-code').value = ''; notice('Connected. Make yourself at home.'); }).catch(function (error) {
      if (!state.token) notice(error.message || 'Pairing failed. Generate a new code on your TV and try again.', true);
      else handleError(error);
    }).then(function () {
      state.pairing = false;
      $('pair-button').disabled = false;
      $('pair-code').disabled = false;
      $('remember-phone').disabled = false;
      $('pair-button').textContent = 'Connect to TV ↗';
      if (!$('pair-view').hidden) { $('pair-code').focus(); $('pair-code').select(); }
    });
  }

  $('pair-form').addEventListener('submit', function (event) {
    event.preventDefault();
    pairWithCode($('pair-code').value.replace(/\s/g, ''), $('remember-phone').checked);
  });

  $('pair-code').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });
  $('disconnect-button').addEventListener('click', function () {
    var remembered = state.remembered;
    clearSession();
    $('reconnect-button').hidden = !remembered;
    notice(remembered ? 'This tab is disconnected. Your phone is still remembered; reopen Still Home or tap Try reconnecting to connect again.' : 'Disconnected from this browser tab.');
  });
  $('remember-button').addEventListener('click', function () {
    if (state.busy || state.upload || state.preparing || state.forgetting) return;
    setBusy(true);
    request('/api/session/remember', { method: 'POST', body: { name: deviceName() } }).then(function (body) {
      acceptSession(body);
      $('install-help').open = true;
      notice('This phone is remembered. You can now add Still Home to your Home Screen.');
    }).catch(handleError).then(function () { setBusy(false); });
  });
  $('forget-button').addEventListener('click', function () {
    if (state.forgetting || !window.confirm('Forget this phone? You will need a new pairing code from your TV to connect again.')) return;
    state.forgetting = true;
    updateControls();
    rawRequest('/api/session/forget', { method: 'POST', body: {} }).then(function () {
      clearSession();
      notice('This phone is forgotten. Use a new code from your TV to connect again.');
    }).catch(function (error) {
      if (error.status !== 499) notice('Could not forget this phone. ' + error.message + ' Your connection is kept; try again when the TV is reachable.', true);
    }).then(function () { state.forgetting = false; updateControls(); });
  });
  $('reconnect-button').addEventListener('click', function () { startSession(true); });
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPrompt = event;
    updateSessionControls();
  });
  $('install-button').addEventListener('click', function () {
    if (!installPrompt) return;
    var prompt = installPrompt;
    installPrompt = null;
    updateSessionControls();
    Promise.resolve(prompt.prompt()).then(function () { return prompt.userChoice; }).catch(function () {
      notice('Use your browser’s Add to Home Screen option shown below.', true);
    });
  });
  window.addEventListener('appinstalled', function () { installPrompt = null; updateSessionControls(); });
  $('refresh-button').addEventListener('click', function () {
    if (state.busy || state.upload || state.preparing) return;
    setBusy(true);
    loadState(false).then(function () { notice(state.appDirty ? 'Settings refreshed. Your unsaved app selection is still here.' : 'Settings refreshed.'); }).catch(handleError).then(function () { setBusy(false); });
  });
  $('wallpaper-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    cancelTransfer(false);
    if (!file) { clearFile(); return; }
    if (!/\.(jpe?g|png|webp|mp4)$/i.test(file.name)) { clearFile(); notice('Choose a JPG, PNG, WebP or MP4 file.', true); return; }
    if (!file.size) { clearFile(); notice('That file is empty. Please choose another file.', true); return; }
    if (file.size > MAX_FILE_SIZE) { clearFile(); notice('That file is larger than 150 MB. Choose a smaller file or shorten the video.', true); return; }
    state.file = file;
    $('selected-file-name').textContent = file.name;
    $('selected-file-size').textContent = sizeLabel(file.size);
    $('selected-file').hidden = false;
    notice('');
    updateControls();
  });
  $('clear-file-button').addEventListener('click', clearFile);
  $('upload-button').addEventListener('click', uploadFile);
  $('cancel-upload-button').addEventListener('click', function () { cancelTransfer(true); });
  $('reset-wallpaper-button').addEventListener('click', function () { selectWallpaper('default'); });
  $('current-focal-button').addEventListener('click', function () { if (state.config) openFocal(state.config.wallpaper ? state.config.wallpaper.id : 'default'); });
  $('focal-close-button').addEventListener('click', function () { closeFocal(false); });
  $('focal-cancel-button').addEventListener('click', function () { closeFocal(false); });
  $('focal-save-button').addEventListener('click', saveFocal);
  $('focal-reset-button').addEventListener('click', function () {
    if (!state.editor || !state.editor.loaded || state.editor.saving) return;
    state.editor.point = null; state.editor.forceDirty = true; renderFocal();
    focalNotice('Original top framing selected. Save to apply it, or Cancel to keep the saved focal point.');
  });
  ['x', 'y'].forEach(function (axis) {
    $('focal-' + axis).addEventListener('input', function () {
      if (!state.editor) return;
      var point = copyPoint(state.editor.point) || { x: 0.5, y: 0.5 };
      point[axis] = Number(this.value) / 1000;
      updateFocalPoint(point);
    });
  });
  $('focal-zoom').addEventListener('input', renderFocal);
  $('focal-surface').addEventListener('pointerdown', function (event) {
    if (!state.editor || !state.editor.loaded || state.editor.saving || event.button !== 0) return;
    state.editor.pointerId = event.pointerId;
    focalPointer(event);
    if (this.setPointerCapture) this.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  $('focal-surface').addEventListener('pointermove', function (event) { if (state.editor && state.editor.pointerId === event.pointerId) focalPointer(event); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (type) { $('focal-surface').addEventListener(type, function () { if (state.editor) state.editor.pointerId = null; }); });
  $('focal-dialog').addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { event.preventDefault(); closeFocal(false); return; }
    if (event.key !== 'Tab') return;
    var items = Array.prototype.filter.call(this.querySelectorAll('button, input, a[href]'), function (item) { return !item.disabled && item.getBoundingClientRect().height > 0; });
    if (!items.length) { event.preventDefault(); return; }
    var first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  window.addEventListener('resize', function () { if (state.editor && state.editor.loaded) renderFocal(); });
  $('wallpaper-dim').addEventListener('input', function () { $('dim-value').textContent = this.value + '%'; });
  $('wallpaper-dim').addEventListener('change', function () { patch({ dim: Number(this.value) / 100 }, 'Wallpaper dimming saved.'); });
  $('launch-at-start').addEventListener('change', function () { patch({launchAtStart:this.checked}, 'Startup preference saved.'); });
  $('ken-burns').addEventListener('change', function () { patch({ kenBurns: this.checked }, this.checked ? 'Slow pan & zoom enabled for photos.' : 'Slow pan & zoom turned off.'); });
  $('temperature-unit').addEventListener('change', function () { patch({ temperatureUnit: this.value }, 'Temperature unit saved.'); });
  $('clock-format').addEventListener('change', function () { patch({ clock24: this.value === '24' }, 'Clock format saved.'); });
  appearanceRanges.forEach(function (setting) {
    $(setting.id).addEventListener('input', function () { $(setting.id + '-value').textContent = this.value + '%'; });
    $(setting.id).addEventListener('change', function () {
      var fields = {};
      fields[setting.field] = Number(this.value) / 100;
      patch(fields, setting.message);
    });
  });
  $('clear-location-button').addEventListener('click', function () { patch({ location: null }, 'Weather hidden until you choose a location.'); });
  $('location-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var query = $('location-query').value.trim();
    if (query.length < 2 || state.busy || state.upload || state.preparing) return;
    var searchId = ++state.searchId;
    $('location-search-button').disabled = true;
    $('location-status').textContent = 'Finding locations…';
    $('location-status').hidden = false;
    $('location-results').hidden = true;
    $('location-results').textContent = '';
    request('/api/location?q=' + encodeURIComponent(query)).then(function (body) {
      if (searchId !== state.searchId || !state.token) return;
      var results = body.results || [];
      $('location-status').textContent = results.length ? 'Choose your location below.' : 'No locations found. Try a nearby city or a more specific name.';
      results.forEach(function (location) {
        var row = document.createElement('li');
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = location.name;
        button.addEventListener('click', function () {
          patch({ location: location }, 'Weather location saved.').then(function (saved) {
            if (!saved) return;
            $('location-results').hidden = true;
            $('location-status').hidden = true;
            $('location-query').value = '';
          });
        });
        row.appendChild(button);
        $('location-results').appendChild(row);
      });
      $('location-results').hidden = !results.length;
    }).catch(function (error) {
      if (searchId !== state.searchId) return;
      $('location-status').textContent = error.message || 'Location search failed. Try again.';
      if (error.status !== 401 && error.status !== 403) handleError(error);
    }).then(function () { if (searchId === state.searchId) updateControls(); });
  });
  $('default-apps-button').addEventListener('click', function () { state.appDraft = state.apps.slice(0, 6).map(function (app) { return app.id; }); renderApps(); });
  $('save-apps-button').addEventListener('click', function () { patch({ appIds: state.appDraft.slice() }, 'Your Home apps are saved.', true); });
  window.addEventListener('offline', function () { connection(false); if (state.token) notice('Your phone is offline. Reconnect to your home Wi-Fi to make changes.', true); });
  window.addEventListener('online', function () {
    if (state.token && !state.busy && !state.upload && !state.preparing) loadState(false).catch(handleError);
    else if (!state.token && !$('reconnect-button').hidden) startSession(true);
  });
  window.addEventListener('beforeunload', function (event) { if (state.upload || state.preparing || state.appDirty || state.editor && state.editor.dirty) { event.preventDefault(); event.returnValue = ''; } });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.token && !state.busy && !state.upload && !state.preparing) {
      loadState(false).catch(handleError);
    }
  });

  if (pairingLinkPresent) {
    clearSession();
    if (scannedPairCode) {
      $('pair-code').value = scannedPairCode;
      pairWithCode(scannedPairCode, true);
      scannedPairCode = '';
    } else {
      notice('This pairing link is not valid. Scan a new QR code on your TV, or enter its six-digit code below.', true);
      $('pair-code').focus();
    }
    return;
  }

  function startSession(forceRecovery) {
    if (state.starting || state.pairing) return;
    state.starting = true;
    $('pair-button').disabled = true;
    $('pair-code').disabled = true;
    $('remember-phone').disabled = true;
    $('reconnect-button').disabled = true;
    notice('Reconnecting to your TV…');
    var restored = false;
    if (!forceRecovery) {
      try {
        var stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
        if (stored && typeof stored.token === 'string' && Number(stored.expiresAt) > Date.now()) {
          state.token = stored.token;
          state.expiresAt = Number(stored.expiresAt);
          state.remembered = stored.remembered === true;
          restored = true;
        }
      } catch (_) { /* The HttpOnly cookie can reconnect without web storage. */ }
    }
    (restored ? Promise.resolve() : recoverSession()).then(function () {
      return loadState(!state.config);
    }).then(function () {
      $('reconnect-button').hidden = true;
      notice('');
    }).catch(function (error) {
      if (error.status === 401) {
        if (restored || forceRecovery) expireSession();
        else clearSession();
      }
      else if (error.status !== 499) {
        $('reconnect-button').hidden = false;
        notice(error.message + ' A remembered connection is kept. Try reconnecting when the TV is reachable.', true);
      }
    }).then(function () {
      state.starting = false;
      $('pair-button').disabled = false;
      $('pair-code').disabled = false;
      $('remember-phone').disabled = false;
      $('reconnect-button').disabled = false;
      updateSessionControls();
    });
  }

  updateSessionControls();
  startSession(false);
}());
