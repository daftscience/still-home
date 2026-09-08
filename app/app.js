(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    baseUrl: '', token: '', config: null, apps: [], weather: null,
    settings: false, tab: 'apps', draftIds: [], draftRevision: 0, dirty: false,
    appConflict: false, busy: false, polling: false, wallpaperKey: '',
    videoFailed: false, pairing: null, restoreFocus: null, lastWeatherFetch: 0,
    weatherLoading: false, locationRequest: 0, dimTimer: null, toastTimer: null,
    authInvalid: false, reauthenticating: false,
    appearancePending: {}, appearanceTimer: null, appearanceSaving: false,
    pointerX: null, pointerY: null, focalEditor: null,
    devices: null, devicesBusy: false, deviceToRevoke: null,
    tabMemory: {}, keyboardVisible: false, resetPreview: null, resetting: false, defaultHome: null
  };
  var nav = window.StillHomeNavigation;
  var tabNames = ['apps','wallpaper','display','pairing','general'];
  var focusSnapshot = null;
  var mediaActions = window.StillHomeMediaActions.create({
    revision:function(){return state.config.revision;}, request:request,
    busy:function(){return state.busy||!!state.focalEditor;}, keyboardVisible:function(){return state.keyboardVisible;},
    config:function(config,own){if(own&&state.dirty&&state.config&&state.draftRevision===state.config.revision)state.draftRevision=config.revision;applyConfig(config);},notify:toast,
    closed:function(id,origin){renderDisplaySettings();if(state.settings)renderAppSettings();var rows=$('wallpaper-library').children,row=rows[Math.min(state.mediaReturnIndex||0,rows.length-1)];restoreFocus(origin&&origin.getAttribute('data-focus-key'),row&&row.querySelector('button:not(:disabled)')||$('library-refresh'));}
  });
  var appRowSignature = '';
  var availableSignature = '';
  var librarySignature = '';
  var bootstrapBridge = null;
  var reducedMotion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  var appearanceFields = {
    kenBurnsSpeed: { id: 'ken-burns-speed', min: 0.25, max: 3, fallback: 1 },
    clockScale: { id: 'clock-scale', min: 0.7, max: 1.5, fallback: 1 },
    dateScale: { id: 'date-scale', min: 0.7, max: 1.5, fallback: 1 },
    weatherScale: { id: 'weather-scale', min: 0.7, max: 1.5, fallback: 1 },
    textShade: { id: 'text-shade', min: 0, max: 0.8, fallback: 0 }
  };

  function text(id, value) {
    var element = $(id);
    var next = String(value);
    if (element.textContent !== next) element.textContent = next;
  }
  function errorMessage(error) { return error && error.message ? error.message : 'Something went wrong. Please try again.'; }
  function toast(message) {
    clearTimeout(state.toastTimer);
    text('toast', message);
    $('toast').hidden = false;
    state.toastTimer = setTimeout(function () { $('toast').hidden = true; }, 5200);
  }
  function notice(message, isError) {
    text('settings-notice', message || '');
    $('settings-notice').hidden = !message;
    $('settings-notice').classList.toggle('error', !!isError);
  }
  function make(tag, className, value) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }
  function button(label, className, key, handler) {
    var element = make('button', className, label);
    element.type = 'button';
    element.setAttribute('data-focus', '');
    element.setAttribute('data-focus-key', key);
    element.addEventListener('click', handler);
    return element;
  }
  function mediaUrl(path) {
    return state.baseUrl + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(state.token);
  }
  function icon(app) {
    var wrapper = make('span', 'app-icon');
    wrapper.setAttribute('aria-hidden', 'true');
    var words = String(app.title || app.id).trim().split(/\s+/);
    wrapper.appendChild(make('span', '', words.map(function (word) { return word.charAt(0); }).slice(0, 2).join('').toUpperCase()));
    if (app.icon) {
      var image = make('img');
      image.alt = '';
      image.src = mediaUrl(app.icon);
      image.addEventListener('error', function () { image.remove(); });
      wrapper.appendChild(image);
    }
    return wrapper;
  }
  function byId(id) {
    return state.apps.find(function (app) { return app.id === id; }) || { id: id, title: id };
  }
  function selectedIds() {
    if (!state.config) return [];
    return state.config.appIds === null ? state.apps.slice(0, 6).map(function (app) { return app.id; }) : state.config.appIds.slice();
  }
  function request(path, options) {
    options = options || {};
    var requestToken = state.token;
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer;
    var timedOut = false;
    var settings = {
      method: options.method || 'GET',
      headers: { 'Authorization': 'Bearer ' + requestToken },
      cache: 'no-store'
    };
    if (options.body !== undefined) {
      settings.headers['Content-Type'] = 'application/json';
      settings.body = JSON.stringify(options.body);
    }
    if (controller) settings.signal = controller.signal;
    var pending = fetch(state.baseUrl + path, settings).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          if (response.status === 401 && requestToken === state.token) state.authInvalid = true;
          var error = new Error(data.error || 'The TV could not complete this request.');
          error.status = response.status;
          error.config = data.config;
          throw error;
        }
        return data;
      });
    });
    var timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        timedOut = true;
        if (controller) controller.abort();
        reject(new Error('The TV took too long to respond. Please try again.'));
      }, options.timeout || 12000);
    });
    return Promise.race([pending, timeout]).catch(function (error) {
      if (timedOut) throw new Error('The TV took too long to respond. Please try again.');
      throw error;
    }).then(function (result) { clearTimeout(timer); return result; }, function (error) { clearTimeout(timer); throw error; });
  }
  function focusKey() { return document.activeElement && document.activeElement.getAttribute('data-focus-key'); }
  function restoreFocus(key, fallback) {
    var elements = candidates();
    var target = elements.find(function (el) { return el.getAttribute('data-focus-key') === key; });
    if (!target && key) {
      var identity = key.replace(/^(up|down|remove)-|^wallpaper-(use|focal|rename|delete)-/, '');
      if (identity !== key) target = elements.find(function (el) {
        return el.getAttribute('data-focus-key').replace(/^(up|down|remove)-|^wallpaper-(use|focal|rename|delete)-/, '') === identity;
      });
    }
    if (!target && focusSnapshot && focusSnapshot.key === key) {
      var groups = nav.rows(focusScope()), row = groups[Math.min(focusSnapshot.row, groups.length - 1)];
      if (row) target = row[Math.min(focusSnapshot.column, row.length - 1)];
    }
    if (!target && fallback && elements.indexOf(fallback) >= 0) target = fallback;
    if (target && target !== document.activeElement) target.focus({preventScroll:true});
  }
  function visible(element) { return nav.visible(element); }
  function renderHomeApps() {
    var ids = selectedIds().filter(function (id) { return state.apps.some(function (app) { return app.id === id; }); });
    var signature = JSON.stringify(ids.map(function (id) { var app = byId(id); return [id, app.title, app.icon]; }));
    if (signature === appRowSignature) return;
    appRowSignature = signature;
    var key = focusKey();
    $('app-row').replaceChildren();
    ids.forEach(function (id) {
      var app = byId(id);
      var card = button('', 'app-card', 'launch-' + id, function () { launch(id); });
      card.setAttribute('aria-label', 'Open ' + app.title);
      card.appendChild(icon(app));
      card.appendChild(make('span', 'app-title', app.title));
      $('app-row').appendChild(card);
    });
    $('apps-empty').hidden = ids.length > 0;
    if (key && key.indexOf('launch-') === 0) restoreFocus(key, $('app-row').querySelector('button') || $('choose-apps'));
  }
  function updateClock() {
    var now = new Date();
    var use24 = state.config && state.config.clock24;
    var hour = now.getHours();
    var minute = String(now.getMinutes()).padStart(2, '0');
    text('clock', String(use24 ? hour : (hour % 12 || 12)).padStart(use24 ? 2 : 1, '0') + ':' + minute);
    text('clock-period', use24 ? '' : (hour >= 12 ? 'PM' : 'AM'));
    text('date', now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    var minuteStamp = now.toISOString().slice(0, 16) + ':00.000Z';
    if ($('clock').getAttribute('datetime') !== minuteStamp) $('clock').setAttribute('datetime', minuteStamp);
    if (state.pairing) {
      var remaining = Math.max(0, Math.ceil((state.pairing.expiresAt - Date.now()) / 1000));
      text('pair-expiry', remaining ? 'Pairing expires in ' + Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') + '. Keep this code private.' : 'This code has expired. Show a new pairing QR code to connect.');
      $('pair-code').style.opacity = remaining ? '1' : '.4';
      if (!remaining) $('pair-qr-wrap').hidden = true;
    }
  }
  function weatherInfo(code, isDay) {
    if (code === 0) return [isDay === false ? '☾' : '☀', 'Clear sky'];
    if (code === 1) return [isDay === false ? '☾' : '☀', 'Mostly clear'];
    if (code === 2) return ['☁', 'Partly cloudy'];
    if (code === 3) return ['☁', 'Overcast'];
    if (code === 45 || code === 48) return ['≋', 'Fog'];
    if (code >= 51 && code <= 57) return ['☂', 'Drizzle'];
    if (code >= 61 && code <= 67) return ['☂', 'Rain'];
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['❄', 'Snow'];
    if (code >= 80 && code <= 82) return ['☂', 'Rain showers'];
    if (code >= 95) return ['ϟ', 'Thunderstorms'];
    return ['◌', 'Current weather'];
  }
  function renderWeather() {
    var location = state.config && state.config.location;
    var weather = state.weather;
    if (!location) {
      text('weather-symbol', '◌'); text('weather-temperature', 'Weather');
      text('weather-description', 'Choose your city'); text('weather-place', 'Set up in Settings');
      $('weather-open').setAttribute('aria-label', 'Choose weather location in Settings');
      return;
    }
    if (!weather || !weather.configured || !Number.isFinite(weather.temperature)) {
      text('weather-symbol', '◌'); text('weather-temperature', '—°');
      text('weather-description', state.weatherLoading ? 'Checking weather…' : 'Weather unavailable');
      text('weather-place', location.name);
      $('weather-open').setAttribute('aria-label', 'Weather for ' + location.name + '. Open settings');
      return;
    }
    var info = weatherInfo(weather.code, weather.isDay);
    var temperature = Math.round(weather.temperature) + '°';
    text('weather-symbol', info[0]); text('weather-temperature', temperature);
    text('weather-description', info[1]); text('weather-place', (weather.location || location.name) + (weather.stale ? ' · Last update' : ''));
    $('weather-open').setAttribute('aria-label', temperature + ' ' + info[1] + ', ' + location.name + (weather.stale ? ', last available weather' : '') + '. Open weather settings');
  }
  function fetchWeather(force) {
    if (!state.config || state.weatherLoading || document.hidden) return Promise.resolve();
    if (!force && Date.now() - state.lastWeatherFetch < 15 * 60 * 1000) return Promise.resolve();
    state.weatherLoading = true;
    renderWeather();
    var locationKey = JSON.stringify([state.config.location, state.config.temperatureUnit]);
    return request('/api/weather', { timeout: 20000 }).then(function (weather) {
      if (JSON.stringify([state.config.location, state.config.temperatureUnit]) !== locationKey) return;
      state.weather = weather;
      state.lastWeatherFetch = Date.now();
    }).catch(function () {
      if (state.weather && state.weather.configured) state.weather.stale = true;
      state.lastWeatherFetch = Date.now() - 14 * 60 * 1000;
    }).then(function () {
      state.weatherLoading = false; renderWeather();
      if (JSON.stringify([state.config.location, state.config.temperatureUnit]) !== locationKey) fetchWeather(true);
    });
  }
  function stopVideo() {
    var video = $('wallpaper-video');
    video.pause();
    if (video.hasAttribute('src')) { video.removeAttribute('src'); video.load(); }
    video.hidden = true;
  }
  function stopPhotoMotion() {
    $('wallpaper-image').classList.remove('photo-motion-running', 'photo-motion');
  }
  function currentFocalPoint() {
    if (!state.config) return null;
    if ($('wallpaper-image').getAttribute('src') === 'wallpaper.jpg') return state.config.defaultFocalPoint || null;
    var wallpaper = state.config.wallpaper;
    return wallpaper ? (wallpaper.kind === 'image' ? wallpaper.focalPoint || null : null) : state.config.defaultFocalPoint || null;
  }
  function updatePhotoFraming() {
    var image = $('wallpaper-image');
    var point = currentFocalPoint();
    var ready = !!point && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    image.classList.toggle('focal-photo', ready);
    var position = 'center top';
    if (ready) {
      var frame = window.StillHomeFocal.computeFrame({
        imageWidth: image.naturalWidth, imageHeight: image.naturalHeight,
        viewportWidth: image.clientWidth || window.innerWidth, viewportHeight: image.clientHeight || window.innerHeight,
        point: point
      });
      position = frame.objectPosition.x.toFixed(5) + '% ' + frame.objectPosition.y.toFixed(5) + '%';
      var x = frame.anchorPercent.x.toFixed(5) + '%';
      var y = frame.anchorPercent.y.toFixed(5) + '%';
      if (image.style.getPropertyValue('--photo-focal-x') !== x) image.style.setProperty('--photo-focal-x', x);
      if (image.style.getPropertyValue('--photo-focal-y') !== y) image.style.setProperty('--photo-focal-y', y);
    }
    if (image.style.objectPosition !== position) image.style.objectPosition = position;
  }
  function updatePhotoMotion() {
    var image = $('wallpaper-image');
    var config = state.config;
    var enabled = !!(config && config.kenBurns);
    var wallpaper = config && config.wallpaper;
    var eligible = false;
    var message = 'Off. Photographs stay still.';
    updatePhotoFraming();
    $('ken-burns-toggle').setAttribute('aria-checked', String(enabled));
    if (enabled) {
      if (wallpaper && wallpaper.kind === 'video') {
        message = 'Saved as on for photographs. Video wallpapers keep their own motion.';
      } else if (reducedMotion && reducedMotion.matches) {
        message = 'Saved as on. Motion is paused by your reduced-motion preference.';
      } else if (!image.complete || !image.naturalWidth || !image.naturalHeight) {
        message = 'Checking the photograph’s resolution…';
      } else {
        // Use untransformed layout dimensions: animation must not feed back
        // into its own resolution check. Cover scaling needs both dimensions.
        var width = image.clientWidth || window.innerWidth;
        var height = image.clientHeight || window.innerHeight;
        var headroom = Math.min(image.naturalWidth / width, image.naturalHeight / height);
        var endScale = Math.min(1.08, headroom * 0.98);
        if (endScale < 1.025) {
          message = 'This photograph has no spare resolution for a clean zoom at this screen size. Choose a larger photo to use motion.';
        } else {
          eligible = true;
          var value = endScale.toFixed(4);
          if (image.style.getPropertyValue('--photo-motion-end') !== value) image.style.setProperty('--photo-motion-end', value);
          if (state.settings) message = 'Ready. Motion starts when you close Settings.';
          else if (document.hidden) message = 'Motion is paused while Still Home is hidden.';
          else if (endScale < 1.075) message = 'Gentle motion is on, with a smaller zoom to keep this photograph sharp.';
          else message = currentFocalPoint() ? 'Gentle motion is on. Your focal point stays fixed on the screen.' : 'Gentle motion is on. The top of your photograph stays anchored.';
        }
      }
    }
    image.classList.toggle('photo-motion', eligible);
    image.classList.toggle('photo-motion-running', eligible && !state.settings && !document.hidden);
    text('ken-burns-status', message);
  }
  function setWallpaper() {
    if (!state.config) return;
    var wallpaper = state.config.wallpaper;
    var key = wallpaper ? wallpaper.id + ':' + wallpaper.kind : 'default';
    var video = $('wallpaper-video');
    var image = $('wallpaper-image');
    document.documentElement.style.setProperty('--dim', state.dimTimer ? Number($('dim-slider').value) / 100 : state.config.dim);
    if (key !== state.wallpaperKey) {
      state.wallpaperKey = key;
      state.videoFailed = false;
      stopVideo();
      stopPhotoMotion();
      $('video-notice').hidden = true;
      image.src = wallpaper && wallpaper.kind === 'image' ? mediaUrl('/media/wallpaper?v=' + encodeURIComponent(wallpaper.id)) : 'wallpaper.jpg';
    }
    if (wallpaper && wallpaper.kind === 'video' && !state.videoFailed && !document.hidden && !video.hasAttribute('src')) {
      video.src = mediaUrl('/media/wallpaper?v=' + encodeURIComponent(wallpaper.id));
      video.muted = true;
      var play = video.play();
      if (play && play.catch) play.catch(function (error) {
        if (error.name !== 'AbortError' && !document.hidden && video.hasAttribute('src')) videoFailure();
      });
    }
    updatePhotoMotion();
  }
  function videoFailure() {
    if (document.hidden || !$('wallpaper-video').hasAttribute('src')) return;
    state.videoFailed = true;
    stopVideo();
    text('video-notice', 'This video could not play on the TV. The included photo is shown instead. Try an H.264 MP4, or choose another wallpaper.');
    $('video-notice').hidden = false;
    toast('This video could not play. Showing the included photo.');
  }
  function applyConfig(config) {
    var oldWeather = state.config ? JSON.stringify([state.config.location, state.config.temperatureUnit]) : '';
    var oldRevision = state.config ? state.config.revision : null;
    state.config = config;
    if (state.focalEditor && state.focalEditor.revision !== config.revision) {
      state.focalEditor.conflict = true;
      $('focal-conflict').hidden = false;
    }
    if (JSON.stringify([config.location, config.temperatureUnit]) !== oldWeather) {
      state.weather = null;
      state.lastWeatherFetch = 0;
      fetchWeather(true);
    }
    updateClock(); setWallpaper(); renderHomeApps(); renderDisplaySettings(); renderWeather();
    if (state.settings && oldRevision !== config.revision) {
      if (state.dirty) {
        state.appConflict = state.draftRevision !== config.revision;
        $('app-conflict').hidden = !state.appConflict;
      } else {
        initAppDraft(); renderAppSettings();
      }
    }
  }
  function renderDisplaySettings() {
    if (!state.config) return;
    var config = state.config;
    $('launch-at-start').setAttribute('aria-checked', String(!!config.launchAtStart));
    $('clock-toggle').setAttribute('aria-checked', String(config.clock24));
    $('unit-f').setAttribute('aria-pressed', String(config.temperatureUnit === 'fahrenheit'));
    $('unit-c').setAttribute('aria-pressed', String(config.temperatureUnit === 'celsius'));
    text('location-current', config.location ? config.location.name : 'No location selected.');
    $('location-clear').hidden = !config.location;
    if (!state.dimTimer && document.activeElement !== $('dim-slider')) {
      $('dim-slider').value = Math.round(config.dim * 100);
      text('dim-value', Math.round(config.dim * 100) + '%');
    }
    text('wallpaper-name', config.wallpaper ? config.wallpaper.name : 'Neutral · included wallpaper');
    text('wallpaper-type', config.wallpaper && config.wallpaper.kind === 'video' ? 'Video' : 'Photo');
    $('wallpaper-reset').disabled = !config.wallpaper || state.busy;
    updatePhotoMotion();
    renderAppearance();
    renderWallpaperLibrary();
  }
  function wallpaperEntries() {
    if (!state.config) return [];
    var entries = [{id: 'default', name: 'Neutral · included photo', kind: 'image', focalPoint: state.config.defaultFocalPoint || null}];
    var saved = state.config.wallpaperLibrary || [];
    saved.forEach(function (entry) { if (entry && entry.id && !entries.some(function (item) { return item.id === entry.id; })) entries.push(entry); });
    if (state.config.wallpaper && !entries.some(function (item) { return item.id === state.config.wallpaper.id; })) entries.push(state.config.wallpaper);
    return entries;
  }
  function wallpaperEntry(id) { return wallpaperEntries().find(function (entry) { return entry.id === id; }); }
  function renderWallpaperLibrary() {
    if (!state.config) return;
    var entries = wallpaperEntries();
    var active = state.config.wallpaper ? state.config.wallpaper.id : 'default';
    var signature = JSON.stringify([active, state.busy, entries.map(function (entry) { return [entry.id, entry.name, entry.kind, entry.focalPoint, entry.width, entry.height]; })]);
    if (signature === librarySignature) return;
    librarySignature = signature;
    var key = focusKey();
    $('wallpaper-library').replaceChildren();
    entries.forEach(function (entry) {
      var row = make('div', 'library-row' + (entry.id === active ? ' is-current' : ''));
      var details = make('div', 'library-details');
      details.appendChild(make('span', 'library-name', entry.name));
      var meta = entry.kind === 'video' ? 'Video' : 'Photo';
      if (entry.width && entry.height) meta += ' · ' + entry.width + ' × ' + entry.height;
      if (entry.kind === 'image' && entry.focalPoint) meta += ' · Focal point set';
      details.appendChild(make('span', 'library-meta', meta));
      var controls = make('div', 'library-controls');
      var select = button(entry.id === active ? 'In use' : 'Use', 'secondary-button', 'wallpaper-use-' + entry.id, function () { selectWallpaper(entry.id); });
      select.disabled = entry.id === active || state.busy;
      select.setAttribute('aria-label', (entry.id === active ? 'Currently using ' : 'Use wallpaper ') + entry.name);
      controls.appendChild(select);
      if (entry.kind === 'image') {
        var focal = button('Focal point', 'secondary-button', 'wallpaper-focal-' + entry.id, function () { openFocalEditor(entry.id); });
        focal.disabled = state.busy;
        focal.setAttribute('aria-label', 'Set focal point for ' + entry.name);
        controls.appendChild(focal);
      }
      if (entry.id !== 'default') ['rename','delete'].forEach(function(action){
        var control=button(action==='rename'?'Rename':'Delete','secondary-button','wallpaper-'+action+'-'+entry.id,function(){state.mediaReturnIndex=entries.indexOf(entry);mediaActions.open(action,entry);});
        control.disabled=state.busy;control.setAttribute('aria-label',(action==='rename'?'Rename ':'Delete ')+entry.name);controls.appendChild(control);
      });
      row.append(details, controls); $('wallpaper-library').appendChild(row);
    });
    if (key && key.indexOf('wallpaper-') === 0) restoreFocus(key, $('library-refresh'));
  }
  function selectWallpaper(id) {
    if (!state.config || state.busy) return;
    var advanceDraft = state.dirty && !state.appConflict && state.draftRevision === state.config.revision;
    state.busy = true; renderWallpaperLibrary(); notice('Changing wallpaper…');
    request('/api/wallpapers/select', {method: 'POST', body: {revision: state.config.revision, id: id}}).then(function (data) {
      if (advanceDraft) state.draftRevision = data.config.revision;
      applyConfig(data.config); notice('Wallpaper selected.');
    }).catch(function (error) {
      if (error.status === 409 && error.config) applyConfig(error.config);
      notice(error.status === 409 ? 'Settings changed on another device. Review the current selection and try again.' : errorMessage(error), true);
    }).then(function () { state.busy = false; renderDisplaySettings(); if (state.settings) renderAppSettings(); });
  }
  function refreshWallpaperLibrary() {
    $('library-refresh').disabled = true;
    request('/api/state').then(function (data) {
      state.apps = data.apps; applyConfig(data.config); notice('Wallpaper library refreshed.');
    }).catch(function (error) { notice(errorMessage(error), true); }).then(function () { $('library-refresh').disabled = false; });
  }
  function copyPoint(point) { return point ? {x: point.x, y: point.y} : null; }
  function renderRememberedPhones() {
    var key = focusKey();
    $('devices-manage').disabled = state.devicesBusy;
    text('devices-manage', state.devices === null ? 'Manage' : 'Refresh');
    $('remembered-phones').replaceChildren();
    if (state.devices !== null) {
      if (!state.devices.length) $('remembered-phones').appendChild(make('p', 'helper', 'No phones are remembered.'));
      state.devices.forEach(function (device) {
        var row = make('div', 'remembered-phone');
        var details = make('div', 'library-details');
        details.appendChild(make('span', 'library-name', device.name || 'Phone'));
        var used = new Date(device.lastUsed);
        details.appendChild(make('span', 'library-meta', Number.isFinite(used.getTime()) ? 'Last used ' + used.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : 'Last used time unavailable'));
        var revoke = button('Forget', 'secondary-button', 'device-revoke-' + device.id, function () {
          state.deviceToRevoke = device;
          text('device-confirm-message', 'Forget ' + (device.name || 'this phone') + '? It will need a new pairing code to reconnect.');
          $('device-confirm').hidden = false;
          $('device-cancel').focus();
        });
        revoke.disabled = state.devicesBusy;
        revoke.setAttribute('aria-label', 'Forget remembered phone ' + (device.name || 'Phone'));
        row.append(details, revoke); $('remembered-phones').appendChild(row);
      });
    }
    ['device-cancel', 'device-confirm-revoke'].forEach(function (id) { $(id).disabled = state.devicesBusy; });
    if (key && key.indexOf('device-') === 0) restoreFocus(key, $('devices-manage'));
  }
  function cancelDeviceRevoke() {
    if (state.devicesBusy) return;
    var device = state.deviceToRevoke;
    state.deviceToRevoke = null;
    $('device-confirm').hidden = true;
    if (device) restoreFocus('device-revoke-' + device.id, $('devices-manage'));
  }
  function refreshRememberedPhones() {
    if (state.devicesBusy) return;
    cancelDeviceRevoke();
    state.devicesBusy = true; renderRememberedPhones();
    text('devices-status', 'Loading remembered phones…');
    request('/api/devices').then(function (data) {
      state.devices = data.devices; text('devices-status', 'Remembered phones updated.');
    }).catch(function (error) { text('devices-status', errorMessage(error)); }).then(function () {
      state.devicesBusy = false; renderRememberedPhones();
    });
  }
  function revokeRememberedPhone() {
    var device = state.deviceToRevoke;
    if (!device || state.devicesBusy) return;
    state.devicesBusy = true; renderRememberedPhones();
    text('devices-status', 'Forgetting ' + (device.name || 'phone') + '…');
    request('/api/devices/revoke', {method: 'POST', body: {id: device.id}}).then(function () {
      state.devices = (state.devices || []).filter(function (entry) { return entry.id !== device.id; });
      state.deviceToRevoke = null; $('device-confirm').hidden = true;
      text('devices-status', (device.name || 'Phone') + ' forgotten. A new pairing code is needed to reconnect.');
    }).catch(function (error) { text('devices-status', errorMessage(error)); }).then(function () {
      state.devicesBusy = false; renderRememberedPhones();
      if (!state.deviceToRevoke) $('devices-manage').focus();
    });
  }
  function focalNotice(message, isError) {
    text('focal-notice', message || '');
    $('focal-notice').hidden = !message;
    $('focal-notice').classList.toggle('error', !!isError);
  }
  function openFocalEditor(id) {
    var entry = wallpaperEntry(id);
    if (!entry || entry.kind !== 'image' || state.busy) return;
    state.focalEditor = {id: id, name: entry.name, point: copyPoint(entry.focalPoint), revision: state.config.revision,
      restoreFocus: focusKey(), loaded: false, saving: false, conflict: false};
    $('focal-scrim').hidden = false;
    $('settings-panel').setAttribute('aria-hidden', 'true');
    text('focal-name', entry.name); text('focal-loading', 'Loading photograph…');
    $('focal-loading').hidden = false; $('focal-crosshair').hidden = true; $('focal-crop-frame').hidden = true;
    $('focal-conflict').hidden = true; focalNotice('');
    text('focal-preview-label', 'Loading framing preview…'); text('focal-readout', '');
    setFocalBusy(false);
    $('focal-image').src = mediaUrl('/media/library?id=' + encodeURIComponent(id));
    $('focal-stage').focus();
  }
  function setFocalBusy(busy) {
    var editor = state.focalEditor;
    ['focal-close', 'focal-cancel', 'focal-original', 'focal-reload', 'focal-overwrite'].forEach(function (id) { $(id).disabled = busy; });
    $('focal-save').disabled = busy || !editor || !editor.loaded;
  }
  function closeFocalEditor() {
    var editor = state.focalEditor;
    if (!editor || editor.saving) return;
    var key = editor.restoreFocus;
    state.focalEditor = null;
    $('focal-image').removeAttribute('src');
    $('focal-scrim').hidden = true;
    $('settings-panel').removeAttribute('aria-hidden');
    restoreFocus(key, $('library-refresh'));
  }
  function renderFocalEditor() {
    var editor = state.focalEditor;
    var image = $('focal-image');
    if (!editor || !editor.loaded || !image.naturalWidth || !image.naturalHeight) return;
    var stage = $('focal-stage');
    var contained = window.StillHomeFocal.containRect({imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, viewportWidth: stage.clientWidth, viewportHeight: stage.clientHeight});
    var frame = window.StillHomeFocal.computeFrame({imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, viewportWidth: 1920, viewportHeight: 1080, point: editor.point});
    var crop = $('focal-crop-frame');
    crop.style.left = contained.left - frame.baseLeft / frame.coverScale * contained.scale + 'px';
    crop.style.top = contained.top - frame.baseTop / frame.coverScale * contained.scale + 'px';
    crop.style.width = 1920 / frame.coverScale * contained.scale + 'px';
    crop.style.height = 1080 / frame.coverScale * contained.scale + 'px';
    crop.hidden = false;
    $('focal-crosshair').hidden = !editor.point;
    if (editor.point) {
      $('focal-crosshair').style.left = contained.left + editor.point.x * contained.width + 'px';
      $('focal-crosshair').style.top = contained.top + editor.point.y * contained.height + 'px';
    }
    text('focal-preview-label', frame.framingLabel);
    text('focal-readout', editor.point ? Math.round(editor.point.x * 100) + '% across · ' + Math.round(editor.point.y * 100) + '% down' : 'No custom focal point');
    text('focal-explanation', !editor.point ? 'Original framing keeps the top of the photograph visible.' : frame.centered ? 'Your point will stay at the center of the TV while the photograph zooms.' : 'This point is near an edge. It stays at the position shown inside the frame, without extra cropping or sideways drift.');
  }
  function setFocalPoint(point) {
    var editor = state.focalEditor;
    if (!editor || editor.saving || !editor.loaded) return;
    editor.point = point ? {x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y))} : null;
    renderFocalEditor();
  }
  function saveFocalPoint(overwrite) {
    var editor = state.focalEditor;
    if (!editor || !editor.loaded || editor.saving || state.busy) return;
    var revision = overwrite ? state.config.revision : editor.revision;
    var point = copyPoint(editor.point);
    var advanceDraft = state.dirty && !state.appConflict && state.draftRevision === state.config.revision;
    editor.saving = true; state.busy = true; setFocalBusy(true); focalNotice('Saving focal point…');
    request('/api/wallpapers/focal', {method: 'POST', body: {revision: revision, id: editor.id, focalPoint: point}}).then(function (data) {
      editor.revision = data.config.revision;
      if (advanceDraft) state.draftRevision = data.config.revision;
      state.busy = false;
      applyConfig(data.config);
      editor.saving = false; closeFocalEditor(); notice('Focal point saved for ' + editor.name + '.');
    }).catch(function (error) {
      if (error.status === 409 && error.config) {
        applyConfig(error.config); editor.conflict = true; $('focal-conflict').hidden = false;
        focalNotice('Your point is still here. Review the conflict before saving.', true);
      } else focalNotice(errorMessage(error), true);
    }).then(function () {
      editor.saving = false; state.busy = false; setFocalBusy(false); renderDisplaySettings();
      if (state.settings) renderAppSettings();
    });
  }
  function reloadFocalPoint() {
    var editor = state.focalEditor;
    if (!editor || editor.saving) return;
    var entry = wallpaperEntry(editor.id);
    if (!entry) { focalNotice('This wallpaper is no longer in the saved library.', true); return; }
    editor.point = copyPoint(entry.focalPoint); editor.revision = state.config.revision; editor.conflict = false;
    $('focal-conflict').hidden = true; focalNotice('Loaded the saved point.'); renderFocalEditor();
  }
  function appearanceValue(key) {
    var value = state.appearancePending[key];
    if (value === undefined && state.config) value = state.config[key];
    return Number.isFinite(value) ? value : appearanceFields[key].fallback;
  }
  function renderAppearance() {
    var active = document.activeElement;
    Object.keys(appearanceFields).forEach(function (key) {
      var field = appearanceFields[key];
      var value = appearanceValue(key);
      document.documentElement.style.setProperty('--' + field.id, value);
      if (key === 'kenBurnsSpeed') document.documentElement.style.setProperty('--photo-motion-duration', (56 / value) + 's');
      if (key === 'textShade') document.documentElement.style.setProperty('--text-shadow', value === 0 ? 'none' : '0 1px 2px rgba(0,0,0,'+value+'), 0 2px 6px rgba(0,0,0,'+(value*0.75)+')');
      $(field.id).value = value;
      text(field.id + '-value', key === 'textShade' && value === 0 ? 'Off' : Math.round(value * 100) + '%');
      $(field.id + '-less').disabled = value <= field.min;
      $(field.id + '-more').disabled = value >= field.max;
    });
    if (active && active.disabled && /-(less|more)$/.test(active.id)) {
      var slider = $(active.id.replace(/-(less|more)$/, ''));
      if (slider && visible(slider)) slider.focus({ preventScroll: true });
    }
  }
  function queueAppearance(key, value) {
    var field = appearanceFields[key];
    state.appearancePending[key] = Math.max(field.min, Math.min(field.max, Math.round(value * 20) / 20));
    renderAppearance();
    clearTimeout(state.appearanceTimer);
    state.appearanceTimer = setTimeout(persistAppearance, 650);
  }
  function persistAppearance() {
    if (state.busy || state.reauthenticating || state.authInvalid || !state.config) {
      state.appearanceTimer = setTimeout(persistAppearance, 300);
      return;
    }
    state.appearanceTimer = null;
    var fields = Object.assign({}, state.appearancePending);
    if (!Object.keys(fields).length) return;
    state.appearanceSaving = true;
    saveSetting(fields, 'Settings saved.').then(function () {
      // Clear only this completed batch: newer slider changes remain queued.
      Object.keys(fields).forEach(function (key) {
        if (state.appearancePending[key] === fields[key]) delete state.appearancePending[key];
      });
      state.appearanceSaving = false;
      renderAppearance();
      if (Object.keys(state.appearancePending).length && !state.appearanceTimer) state.appearanceTimer = setTimeout(persistAppearance, 300);
    });
  }
  function initAppDraft() {
    state.draftIds = selectedIds();
    state.draftRevision = state.config ? state.config.revision : 0;
    state.dirty = false;
    state.appConflict = false;
    $('app-conflict').hidden = true;
  }
  function updateDirty() {
    state.dirty = JSON.stringify(state.draftIds) !== JSON.stringify(selectedIds()) || (state.config && state.config.appIds === null);
    $('apps-save').disabled = !state.dirty || state.busy;
    $('apps-reset').disabled = !state.dirty || state.busy;
  }
  function renderAppSettings() {
    var key = focusKey();
    var selectedContainer = $('selected-apps');
    selectedContainer.replaceChildren();
    text('selected-count', state.draftIds.length + (state.draftIds.length === 1 ? ' app' : ' apps'));
    if (!state.draftIds.length) selectedContainer.appendChild(make('p', 'empty-list', 'A quiet home. Choose an app below to add it.'));
    state.draftIds.forEach(function (id, index) {
      var app = byId(id);
      var row = make('div', 'selected-row');
      row.appendChild(make('span', 'selected-number', index + 1));
      row.appendChild(icon(app));
      row.appendChild(make('span', 'selected-title', app.title));
      var controls = make('div', 'order-controls');
      var up = button('↑', 'order-button', 'up-' + id, function () { moveApp(id, -1); });
      up.setAttribute('aria-label', 'Move ' + app.title + ' earlier'); up.disabled = index === 0 || state.busy;
      var down = button('↓', 'order-button', 'down-' + id, function () { moveApp(id, 1); });
      down.setAttribute('aria-label', 'Move ' + app.title + ' later'); down.disabled = index === state.draftIds.length - 1 || state.busy;
      var remove = button('×', 'order-button', 'remove-' + id, function () { toggleApp(id); });
      remove.setAttribute('aria-label', 'Remove ' + app.title + ' from home');
      remove.disabled = state.busy;
      controls.append(up, down, remove); row.appendChild(controls); selectedContainer.appendChild(row);
    });
    var signature = JSON.stringify(state.apps.map(function (app) { return [app.id, app.title, app.icon]; }));
    if (availableSignature !== signature) {
      availableSignature = signature;
      $('available-apps').replaceChildren();
      if (!state.apps.length) $('available-apps').appendChild(make('p', 'empty-list', 'No apps found. Try Refresh.'));
      state.apps.forEach(function (app) {
        var choice = button('', 'available-app', 'select-' + app.id, function () { toggleApp(app.id); });
        choice.setAttribute('data-app-id', app.id);
        choice.appendChild(icon(app));
        choice.appendChild(make('span', 'name', app.title));
        choice.appendChild(make('span', 'app-check'));
        $('available-apps').appendChild(choice);
      });
    }
    Array.prototype.forEach.call($('available-apps').querySelectorAll('[data-app-id]'), function (element) {
      var selected = state.draftIds.indexOf(element.getAttribute('data-app-id')) >= 0;
      element.setAttribute('aria-pressed', String(selected));
      element.disabled = state.busy;
      element.querySelector('.app-check').textContent = selected ? '✓' : '';
    });
    $('apps-save').disabled = !state.dirty || state.busy;
    $('apps-reset').disabled = !state.dirty || state.busy;
    if (key && state.settings) restoreFocus(key, $('apps-save').disabled ? $('apps-refresh') : $('apps-save'));
  }
  function toggleApp(id) {
    if (state.busy) return;
    var index = state.draftIds.indexOf(id);
    if (index === -1) state.draftIds.push(id); else state.draftIds.splice(index, 1);
    updateDirty(); renderAppSettings();
  }
  function moveApp(id, direction) {
    if (state.busy) return;
    var index = state.draftIds.indexOf(id);
    var destination = index + direction;
    if (index < 0 || destination < 0 || destination >= state.draftIds.length) return;
    state.draftIds.splice(index, 1); state.draftIds.splice(destination, 0, id);
    updateDirty(); renderAppSettings();
    var atEnd = direction < 0 ? destination === 0 : destination === state.draftIds.length - 1;
    var key = (atEnd ? 'remove-' : direction < 0 ? 'up-' : 'down-') + id;
    restoreFocus(key, $('apps-save'));
  }
  function saveAppList(overwrite) {
    if (!state.config || state.busy || !state.dirty) return;
    state.busy = true; renderAppSettings(); notice('Saving your app list…');
    var ids = state.draftIds.slice();
    request('/api/config', { method: 'PATCH', body: { revision: overwrite ? state.config.revision : state.draftRevision, appIds: ids } }).then(function (data) {
      state.dirty = false;
      applyConfig(data.config);
      initAppDraft(); renderAppSettings(); notice('App list saved.');
    }).catch(function (error) {
      if (error.status === 409 && error.config) {
        applyConfig(error.config);
        state.appConflict = true; $('app-conflict').hidden = false;
        notice('Your choices are still here. Review the settings conflict below.', true);
      } else notice(errorMessage(error), true);
    }).then(function () { state.busy = false; renderAppSettings(); renderDisplaySettings(); });
  }
  function saveSetting(fields, message) {
    if (!state.config) { notice('Still connecting to the TV. Please try again shortly.', true); return Promise.resolve(false); }
    if (state.busy) { notice('Please wait for the current change to finish.'); return Promise.resolve(false); }
    state.busy = true;
    var advanceDraft = state.dirty && !state.appConflict && state.draftRevision === state.config.revision;
    var advanceFocal = state.focalEditor && !state.focalEditor.conflict && state.focalEditor.revision === state.config.revision;
    var body = Object.assign({ revision: state.config.revision }, fields);
    return request('/api/config', { method: 'PATCH', body: body }).then(function (data) {
      if (advanceDraft) state.draftRevision = data.config.revision;
      if (advanceFocal && state.focalEditor) state.focalEditor.revision = data.config.revision;
      applyConfig(data.config);
      notice(message || 'Saved.');
      return true;
    }).catch(function (error) {
      if (error.status === 409 && error.config) {
        applyConfig(error.config);
        notice('Settings changed on another device. The latest values are shown; try your change again.', true);
      } else notice(errorMessage(error), true);
      if (fields.dim !== undefined) {
        document.documentElement.style.setProperty('--dim', state.config.dim);
        $('dim-slider').value = Math.round(state.config.dim * 100);
        text('dim-value', Math.round(state.config.dim * 100) + '%');
      }
      return false;
    }).then(function (saved) { state.busy = false; renderDisplaySettings(); if (state.settings) renderAppSettings(); return saved; });
  }
  function switchTab(tab, focus) {
    if (tabNames.indexOf(tab) < 0) return;
    if (tab !== state.tab) notice('');
    var oldPanel = $('section-' + state.tab), active = document.activeElement;
    var memory = state.tabMemory[state.tab] || {};
    memory.scroll = document.querySelector('.panel-body').scrollTop;
    if (oldPanel.contains(active)) memory.key = focusKey();
    state.tabMemory[state.tab] = memory;
    if (tab !== 'pairing') {
      state.deviceToRevoke = null;
      $('device-confirm').hidden = true;
    }
    state.tab = tab;
    tabNames.forEach(function (name) {
      $('section-' + name).hidden = name !== tab;
      var control = document.querySelector('[data-tab="' + name + '"]');
      control.classList.toggle('active', name === tab);
      control.setAttribute('aria-pressed', String(name === tab));
      control.setAttribute('aria-selected', String(name === tab));
    });
    document.querySelector('.panel-body').scrollTop = (state.tabMemory[tab] || {}).scroll || 0;
    if (tab === 'pairing') checkPairing();
    if (tab === 'general') refreshGeneral();
    if (focus) document.querySelector('[data-tab="' + tab + '"]').focus();
  }
  function openSettings(tab) {
    state.restoreFocus = focusKey() || 'settings-open';
    state.settings = true;
    updatePhotoMotion();
    $('settings-scrim').hidden = false;
    $('home').setAttribute('aria-hidden', 'true');
    notice('');
    if (!state.dirty) initAppDraft();
    renderAppSettings(); renderDisplaySettings(); switchTab(tab || 'apps', true);
  }
  function closeSettings() {
    cancelDeviceRevoke();
    state.deviceToRevoke = null;
    $('device-confirm').hidden = true;
    state.settings = false;
    updatePhotoMotion();
    $('settings-scrim').hidden = true;
    $('home').removeAttribute('aria-hidden');
    restoreFocus(state.restoreFocus, $('settings-open'));
    if (state.dirty) toast('App choices are unsaved. Open Settings to save or undo them.');
  }
  function launch(id) {
    if (state.busy) return;
    state.busy = true;
    request('/api/launch', { method: 'POST', body: { id: id } }).catch(function (error) { toast(errorMessage(error)); }).then(function () { state.busy = false; });
  }
  function refreshApps() {
    $('apps-refresh').disabled = true;
    notice('Checking installed apps…');
    request('/api/apps').then(function (data) {
      state.apps = data.apps;
      renderHomeApps();
      if (!state.dirty) initAppDraft();
      renderAppSettings(); notice('App list refreshed.');
    }).catch(function (error) { notice(errorMessage(error), true); }).then(function () { $('apps-refresh').disabled = false; });
  }
  function searchLocation(event) {
    event.preventDefault();
    var query = $('location-query').value.trim();
    if (query.length < 2) { text('location-status', 'Enter at least two characters.'); return; }
    var requestId = ++state.locationRequest;
    $('location-search').disabled = true;
    text('location-status', 'Searching…'); $('location-results').replaceChildren();
    request('/api/location?q=' + encodeURIComponent(query), { timeout: 20000 }).then(function (data) {
      if (requestId !== state.locationRequest) return;
      text('location-status', data.results.length ? 'Choose a location:' : 'No locations found. Try a nearby city or a longer place name.');
      data.results.forEach(function (location, index) {
        var result = button(location.name, 'location-result', 'location-' + index, function () {
          saveSetting({ location: location }, 'Weather location saved.').then(function (saved) {
            if (saved) { $('location-results').replaceChildren(); text('location-status', ''); $('location-query').value = ''; $('location-query').focus(); }
          });
        });
        $('location-results').appendChild(result);
      });
    }).catch(function (error) { if (requestId === state.locationRequest) text('location-status', errorMessage(error)); }).then(function () { if (requestId === state.locationRequest) $('location-search').disabled = false; });
  }
  function pairPhone() {
    $('pair-generate').disabled = true;
    $('pair-qr-wrap').hidden = true;
    notice('Creating a private pairing code…');
    request('/api/pairing', { method: 'POST', body: {} }).then(function (data) {
      state.pairing = data;
      $('pair-url').href = data.url;
      text('pair-url', data.url); text('pair-code', data.code);
      $('pair-details').hidden = false;
      $('pair-manual').open = false;
      var qrReady = drawPairingQR(data.qrUrl || data.url.replace(/\/$/, '') + '/#pair=' + encodeURIComponent(data.code));
      $('pair-manual').open = !qrReady;
      updateClock(); if (state.settings && state.tab === 'pairing') notice(qrReady ? 'Ready. Scan the QR code with your phone’s camera.' : 'QR code unavailable. Use the address and code below.');
      if (qrReady) requestAnimationFrame(function () {
        if (state.settings && state.tab === 'pairing' && state.pairing === data && !$('pair-qr-wrap').hidden) {
          $('pair-qr').scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
        }
      });
    }).catch(function (error) { notice(errorMessage(error), true); }).then(function () { $('pair-generate').disabled = false; });
  }
  function drawPairingQR(url) {
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(url); qr.make();
      var modules = qr.getModuleCount();
      var quiet = 4;
      var cell = Math.max(6, Math.floor(340 / (modules + quiet * 2)));
      var canvas = $('pair-qr');
      canvas.width = canvas.height = (modules + quiet * 2) * cell;
      var context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000';
      for (var row = 0; row < modules; row++) {
        for (var column = 0; column < modules; column++) {
          if (qr.isDark(row, column)) context.fillRect((column + quiet) * cell, (row + quiet) * cell, cell, cell);
        }
      }
      $('pair-qr-wrap').hidden = false;
      return true;
    } catch (error) {
      $('pair-qr-wrap').hidden = true;
      return false;
    }
  }
  function setDim(value) {
    value = Math.min(75, Math.max(0, Math.round(value)));
    $('dim-slider').value = value;
    text('dim-value', value + '%');
    document.documentElement.style.setProperty('--dim', value / 100);
    clearTimeout(state.dimTimer);
    function persistDim() {
      if (state.busy) { state.dimTimer = setTimeout(persistDim, 250); return; }
      state.dimTimer = null;
      saveSetting({ dim: value / 100 }, 'Wallpaper dimming saved.');
    }
    state.dimTimer = setTimeout(persistDim, 600);
  }
  function pollState() {
    if (!state.token || state.polling || state.busy || state.reauthenticating || document.hidden) return;
    if (state.authInvalid) { recoverAuthentication(); return; }
    state.polling = true;
    request('/api/state').then(function (data) {
      state.apps = data.apps;
      if (state.tab === 'pairing') checkPairing();
      if (!state.config || data.config.revision !== state.config.revision) applyConfig(data.config);
      else renderHomeApps();
      text('connection-state', '');
    }).catch(function (error) {
      if (error.status === 401) return recoverAuthentication();
      // HTTP cannot wake an idle webOS service. Use the Luna bootstrap on the
      // next poll after a network failure, which can reactivate that service.
      if (!error.status) state.authInvalid = true;
      text('connection-state', 'TV connection interrupted · retrying');
    }).then(function () { state.polling = false; });
  }
  function recoverAuthentication() {
    if (state.reauthenticating) return Promise.resolve();
    state.reauthenticating = true;
    text('connection-state', 'Reconnecting to the TV…');
    return bootstrap().then(function (data) {
      state.baseUrl = data.baseUrl.replace(/\/$/, '');
      state.token = data.token;
      return request('/api/state');
    }).then(function (data) {
      // A restarted service issues a new token, including for every media URL.
      appRowSignature = '';
      availableSignature = '';
      state.wallpaperKey = '';
      state.apps = data.apps;
      state.authInvalid = false;
      state.pairing = null;
      $('pair-details').hidden = true;
      applyConfig(data.config);
      // Preserve unsaved choices and their revision so conflicts remain explicit.
      if (!state.dirty) initAppDraft();
      if (state.settings) renderAppSettings();
      text('connection-state', '');
    }).catch(function () {
      state.authInvalid = true;
      text('connection-state', 'TV connection interrupted · retrying');
    }).then(function () { state.reauthenticating = false; });
  }
  function focusScope() {
    if (mediaActions && mediaActions.isOpen()) return mediaActions.scope();
    if (!$('reset-scrim').hidden) return $('reset-dialog');
    if (state.deviceToRevoke) return $('device-confirm');
    return state.focalEditor ? $('focal-panel') : state.settings ? $('settings-panel') : $('home');
  }
  function candidates() { return nav.controls(focusScope()); }
  function focusTarget(target) {
    if (!target || !visible(target)) return;
    target.focus({preventScroll:true});
    target.scrollIntoView({block:'nearest',inline:'nearest',behavior:'auto'});
  }
  function enterTab(tab) {
    if (state.tab !== tab) switchTab(tab, false);
    var elements=nav.controls($('section-'+tab)), key=(state.tabMemory[tab]||{}).key;
    var target=elements.find(function(el){return el.getAttribute('data-focus-key')===key;})||elements[0];
    focusTarget(target && (nav.scalar(target)||target));
  }
  function navigate(direction) {
    var current=document.activeElement, scope=focusScope(), elements=candidates(), target=current;
    if (!elements.length) return;
    var slider=current && current.closest && nav.scalar(current);
    if (slider && visible(slider)) {
      current=slider;
      if (direction==='left'||direction==='right') {
        var value=Math.max(Number(slider.min),Math.min(Number(slider.max),Number(slider.value)+(direction==='left'?-1:1)*Number(slider.step||1)));
        slider.focus({preventScroll:true});slider.value=String(value);slider.dispatchEvent(new Event('input',{bubbles:true}));return;
      }
    }
    if (state.settings && scope===$('settings-panel')) {
      var tab=current.getAttribute && current.getAttribute('data-tab');
      if (tab) {
        var index=tabNames.indexOf(tab);
        if (direction==='left'||direction==='right') target=document.querySelector('[data-tab="'+(tabNames[index+(direction==='left'?-1:1)]||tab)+'"]');
        else if (direction==='down') {enterTab(tab);return;}
        else target=$('settings-close');
      } else if (current===$('settings-close')) {
        if(direction==='down')target=document.querySelector('[data-tab="'+state.tab+'"]');
      } else {
        var groups=nav.rows($('section-'+state.tab));
        target=nav.next(groups,current,direction);
        if(direction==='up'&&groups.length&&groups[0].indexOf(current)>=0)target=document.querySelector('[data-tab="'+state.tab+'"]');
      }
    } else if (!state.settings && !state.focalEditor && scope===$('home')) {
      var apps=nav.controls($('app-row'));
      if(!apps.length)apps=nav.controls($('apps-empty'));
      var top=[$('settings-open'),$('weather-open')], index=apps.indexOf(current);
      if(index>=0){
        if(direction==='left'||direction==='right')target=apps[index+(direction==='left'?-1:1)]||current;
        if(direction==='up')target=$('settings-open');
        state.lastHomeKey=current.getAttribute('data-focus-key');
      }else{
        if(direction==='down')target=apps.find(function(el){return el.getAttribute('data-focus-key')===state.lastHomeKey;})||apps[0];
        if(direction==='left'||direction==='right')target=top[top.indexOf(current)+(direction==='left'?-1:1)]||current;
      }
    } else target=nav.next(nav.rows(scope),current,direction);
    if(elements.indexOf(current)<0 && !slider)target=elements[0];
    var before=focusKey();focusTarget(target);
    if(new URLSearchParams(location.search).get('navDebug')==='1') {
      window.stillHomeNavigationTrace=window.stillHomeNavigationTrace||[];
      window.stillHomeNavigationTrace.push({at:Date.now(),direction:direction,from:before,to:focusKey(),scope:scope.id,scroll:document.querySelector('.panel-body').scrollTop});
      if(window.stillHomeNavigationTrace.length>200)window.stillHomeNavigationTrace.shift();
    }
  }
  function keydown(event) {
    var code = event.keyCode || event.which;
    var key = event.key;
    if (state.keyboardVisible) return;
    if (code === 13 && event.repeat) { event.preventDefault(); return; }
    if (code === 461 || key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (mediaActions.isOpen()) {mediaActions.cancel();return;}
      if (!$('reset-scrim').hidden) { cancelReset(); return; }
      if (state.focalEditor) { closeFocalEditor(); return; }
      if (state.deviceToRevoke) { cancelDeviceRevoke(); return; }
      if (state.settings) { closeSettings(); return; }
      if (window.webOS && typeof window.webOS.platformBack === 'function') window.webOS.platformBack();
      else if (window.PalmSystem && typeof window.PalmSystem.platformBack === 'function') window.PalmSystem.platformBack();
      else if (window.PalmSystem) window.close();
      return;
    }
    if (key === 'Tab') {
      var elements = candidates();
      if (!elements.length) return;
      event.preventDefault();
      var index = elements.indexOf(document.activeElement);
      elements[(index + (event.shiftKey ? -1 : 1) + elements.length) % elements.length].focus();
      return;
    }
    var directions = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
    if (directions[code]) document.documentElement.setAttribute('data-input-mode', 'keys');
    if (state.focalEditor && document.activeElement === $('focal-stage')) {
      if (directions[code]) {
        event.preventDefault();
        var point = copyPoint(state.focalEditor.point) || {x: 0.5, y: 0.5};
        var step = event.shiftKey ? 0.005 : 0.01;
        if (code === 37) point.x -= step;
        if (code === 39) point.x += step;
        if (code === 38) point.y -= step;
        if (code === 40) point.y += step;
        setFocalPoint(point); return;
      }
      if (code === 13) { event.preventDefault(); if (!$('focal-save').disabled) $('focal-save').focus(); return; }
    }
    if (directions[code]) {
      document.documentElement.setAttribute('data-input-mode', 'keys');
      var target = document.activeElement;
      if (target && target.tagName === 'INPUT' && target.type !== 'range' && (code === 37 || code === 39)) return;
      event.preventDefault(); navigate(directions[code]);
    }
    if (code === 13) {
      var active = document.activeElement;
      if (active && /^(BUTTON|A|SUMMARY)$/.test(active.tagName) && visible(active) && focusScope().contains(active)) {
        event.preventDefault(); active.click(); return;
      }
    }
    if (code === 13 && document.activeElement === document.body) { event.preventDefault(); var controls = candidates(); if (controls.length) controls[0].focus(); }
  }
  function pointerFocus(event) {
    // Layout/scroll-induced mouseover never reclaims focus from five-way input.
    if(event.type==='mousemove') {
      if(state.pointerX===event.clientX && state.pointerY===event.clientY)return;
      state.pointerX=event.clientX;state.pointerY=event.clientY;
    } else if(event.type!=='pointerdown') return;
    document.documentElement.setAttribute('data-input-mode','pointer');
    var target=event.target.closest && event.target.closest('[data-focus]');
    if(!target || target.tagName==='INPUT' || !visible(target) || !focusScope().contains(target))return;
    if(target!==document.activeElement)target.focus({preventScroll:true});
  }
  function checkPairing() {
    var pairing=state.pairing;
    if(!pairing || !pairing.id)return;
    request('/api/pairing/status?id='+encodeURIComponent(pairing.id)).then(function(data){
      if(state.pairing!==pairing)return;
      if(!data.valid){state.pairing=null;$('pair-qr-wrap').hidden=true;$('pair-manual').open=false;text('pair-code','');$('pair-url').removeAttribute('href');text('pair-expiry','This code was used or expired. Generate a new code to connect another phone.');}
    }).catch(function(){});
  }
  function refreshGeneral() {
    text('default-home-status','Checking Magic Mapper…');
    request('/api/default-home').then(function(data){
      state.defaultHome=data;text('default-home-status',data.message);
      $('default-home-setup').disabled=!data.mapperId;
    }).catch(function(error){text('default-home-status',errorMessage(error));});
  }
  function openReset() {
    if(state.busy || state.appearanceSaving || state.dimTimer || state.appearanceTimer){toast('Wait for current settings to finish saving, then try Reset again.');return;}
    $('reset-open').disabled=true;text('reset-status','Checking what will be reset…');
    request('/api/reset/preview',{method:'POST',body:{}}).then(function(data){
      if(!state.settings || state.tab!=='general')return;
      state.resetPreview=data;state.resetting=false;
      text('reset-summary',data.count+' uploaded wallpapers · '+(data.bytes/1048576).toFixed(1)+' MB will be deleted.');
      text('reset-dialog-status','');text('reset-confirm','Reset and delete wallpapers');$('reset-confirm').disabled=false;$('reset-cancel').disabled=false;
      $('reset-scrim').hidden=false;$('reset-cancel').focus();text('reset-status','');
    }).catch(function(error){text('reset-status',errorMessage(error));}).then(function(){$('reset-open').disabled=false;});
  }
  function cancelReset() {
    if(state.resetting || $('reset-cancel').disabled)return;
    $('reset-scrim').hidden=true;state.resetPreview=null;$('reset-open').focus();
  }
  function resetComplete(data) {
    state.resetting=false;state.busy=false;state.resetPreview=null;
    clearTimeout(state.dimTimer);clearTimeout(state.appearanceTimer);
    state.dimTimer=null;state.appearanceTimer=null;state.appearancePending={};
    state.pairing=null;state.devices=null;state.deviceToRevoke=null;state.dirty=false;state.locationRequest++;
    $('location-results').replaceChildren();$('location-query').value='';text('location-status','');
    $('pair-details').hidden=true;$('device-confirm').hidden=true;$('reset-scrim').hidden=true;
    state.wallpaperKey='';librarySignature='';applyConfig(data.config);initAppDraft();renderAppSettings();renderRememberedPhones();
    state.tabMemory={};switchTab('general',false);text('reset-status','Still Home reset. Uploaded wallpapers deleted; phones must pair again.');
    $('reset-open').focus();
  }
  function confirmReset() {
    if(!state.resetPreview || state.resetting)return;
    state.resetting=true;state.busy=true;$('reset-confirm').disabled=true;$('reset-cancel').disabled=true;
    clearTimeout(state.dimTimer);clearTimeout(state.appearanceTimer);state.appearancePending={};
    text('reset-dialog-status','Resetting… Keep the TV on. This cannot be cancelled.');
    var preview=state.resetPreview;
    request('/api/reset/confirm',{method:'POST',body:{id:preview.id,token:preview.token},timeout:45000}).then(resetComplete).catch(function(error){
      return request('/api/reset/status').then(function(data){
        if(data.operation&&data.operation.id===preview.id&&data.operation.status==='complete'){resetComplete(data);return;}
        // A rejected preflight has not committed: allow Cancel and review again.
        if(!data.operation || data.operation.id!==preview.id){$('reset-cancel').disabled=false;}
        throw error;
      }).catch(function(failure){
        state.resetting=false;state.busy=false;$('reset-confirm').disabled=false;
        text('reset-dialog-status',errorMessage(failure)+' Choose Retry to resume, or Cancel if available to review again.');
        text('reset-confirm','Retry reset');$('reset-confirm').focus();
      });
    });
  }
  function restoreNativeCursor() {
    var platform = window.webOSSystem;
    if (!platform || typeof platform.setCursor !== 'function') platform = window.PalmSystem;
    if (!platform || typeof platform.setCursor !== 'function') return;
    try {
      // Restore the TV's normal cursor image without forcing pointer visibility;
      // the Magic Remote still controls switching between pointer and arrows.
      platform.setCursor('default', 0, 0);
    } catch (error) { /* A missing native cursor API must not interrupt Home. */ }
  }
  function bootstrap() {
    if (new URLSearchParams(location.search).get('preview') === '1') return fetch('/demo/bootstrap').then(function (response) { if (!response.ok) throw new Error('Preview is unavailable.'); return response.json(); });
    return new Promise(function (resolve, reject) {
      if (typeof window.PalmServiceBridge !== 'function') { reject(new Error('Open Still Home on your TV to connect.')); return; }
      var finished = false;
      var timer = setTimeout(function () { if (!finished) { finished = true; reject(new Error('Still Home’s TV service did not respond.')); } }, 12000);
      bootstrapBridge = new window.PalmServiceBridge();
      bootstrapBridge.onservicecallback = function (response) {
        if (finished) return;
        finished = true; clearTimeout(timer);
        try {
          var data = JSON.parse(response);
          if (!data.returnValue || !data.token || !data.baseUrl) throw new Error(data.errorText || 'Still Home’s TV service is unavailable.');
          resolve(data);
        } catch (error) { reject(error); }
      };
      bootstrapBridge.call('luna://com.tomperry.stillhome.service/bootstrap', '{}');
    });
  }
  function connect() {
    text('connection-state', 'Connecting…');
    return bootstrap().then(function (data) {
      state.baseUrl = data.baseUrl.replace(/\/$/, ''); state.token = data.token;
      return request('/api/state');
    }).then(function (data) {
      state.apps = data.apps; applyConfig(data.config); initAppDraft();
      text('connection-state', '');
      if (document.activeElement === document.body) ($('app-row').querySelector('button') || $('settings-open')).focus();
    }).catch(function (error) {
      text('connection-state', errorMessage(error) + ' Retrying…');
      setTimeout(function () { if (!state.config) connect(); }, 10000);
    });
  }

  $('settings-open').addEventListener('click', function () { openSettings('apps'); });
  $('weather-open').addEventListener('click', function () { openSettings('display'); });
  $('choose-apps').addEventListener('click', function () { openSettings('apps'); });
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-scrim').addEventListener('click', function (event) { if (event.target === $('settings-scrim')) closeSettings(); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-tab]'), function (element) { element.addEventListener('click', function () { switchTab(element.getAttribute('data-tab'), false); }); });
  $('apps-save').addEventListener('click', function () { saveAppList(false); });
  $('apps-overwrite').addEventListener('click', function () { saveAppList(true); });
  $('apps-reset').addEventListener('click', function () { initAppDraft(); renderAppSettings(); notice('Unsaved app choices cleared.'); });
  $('apps-reload').addEventListener('click', function () { initAppDraft(); renderAppSettings(); notice('Loaded the saved app list.'); });
  $('apps-refresh').addEventListener('click', refreshApps);
  $('clock-toggle').addEventListener('click', function () { if (state.config) saveSetting({ clock24: !state.config.clock24 }, 'Clock format saved.'); });
  $('unit-f').addEventListener('click', function () { saveSetting({ temperatureUnit: 'fahrenheit' }, 'Temperature unit saved.'); });
  $('unit-c').addEventListener('click', function () { saveSetting({ temperatureUnit: 'celsius' }, 'Temperature unit saved.'); });
  $('location-form').addEventListener('submit', searchLocation);
  $('location-clear').addEventListener('click', function () { saveSetting({ location: null }, 'Weather location cleared.'); });
  $('connect-phone').addEventListener('click',function(){switchTab('pairing',false);$('pair-generate').focus();});
  $('launch-at-start').addEventListener('click', function () { if(state.config)saveSetting({launchAtStart: !state.config.launchAtStart}, 'Startup preference saved.'); });
  $('general-refresh').addEventListener('click',refreshGeneral);
  $('default-home-setup').addEventListener('click',function(){
    if(state.defaultHome && state.defaultHome.mapperId)launch(state.defaultHome.mapperId);
  });
  $('reset-open').addEventListener('click',openReset);
  $('reset-cancel').addEventListener('click',cancelReset);
  $('reset-confirm').addEventListener('click',confirmReset);
  $('pair-generate').addEventListener('click', pairPhone);
  $('devices-manage').addEventListener('click', refreshRememberedPhones);
  $('device-cancel').addEventListener('click', cancelDeviceRevoke);
  $('device-confirm-revoke').addEventListener('click', revokeRememberedPhone);
  $('wallpaper-reset').addEventListener('click', function () { saveSetting({ wallpaper: null }, 'Included wallpaper restored.'); });
  $('library-refresh').addEventListener('click', refreshWallpaperLibrary);
  ['focal-close', 'focal-cancel'].forEach(function (id) { $(id).addEventListener('click', closeFocalEditor); });
  $('focal-save').addEventListener('click', function () { saveFocalPoint(false); });
  $('focal-overwrite').addEventListener('click', function () { saveFocalPoint(true); });
  $('focal-reload').addEventListener('click', reloadFocalPoint);
  $('focal-original').addEventListener('click', function () { setFocalPoint(null); });
  $('focal-stage').addEventListener('click', function (event) {
    var editor = state.focalEditor;
    var image = $('focal-image');
    if (!editor || !editor.loaded || editor.saving) return;
    var point = window.StillHomeFocal.pointFromClient({rect: $('focal-stage').getBoundingClientRect(), imageWidth: image.naturalWidth, imageHeight: image.naturalHeight, clientX: event.clientX, clientY: event.clientY});
    if (point) setFocalPoint(point);
    $('focal-stage').focus({preventScroll: true});
  });
  $('focal-image').addEventListener('load', function () {
    if (!state.focalEditor) return;
    state.focalEditor.loaded = true; $('focal-loading').hidden = true; setFocalBusy(false); renderFocalEditor();
  });
  $('focal-image').addEventListener('error', function () {
    if (!state.focalEditor) return;
    state.focalEditor.loaded = false; text('focal-loading', 'This photograph could not be opened. Try another saved photo.');
    $('focal-loading').hidden = false; setFocalBusy(false);
  });
  $('ken-burns-toggle').addEventListener('click', function () {
    if (state.config) saveSetting({ kenBurns: !state.config.kenBurns }, 'Photo motion preference saved.');
  });
  $('dim-slider').addEventListener('input', function () { setDim(Number($('dim-slider').value)); });
  $('dim-less').addEventListener('click', function () { setDim(Number($('dim-slider').value) - 5); });
  $('dim-more').addEventListener('click', function () { setDim(Number($('dim-slider').value) + 5); });
  Object.keys(appearanceFields).forEach(function (key) {
    var id = appearanceFields[key].id;
    $(id).addEventListener('input', function () { queueAppearance(key, Number($(id).value)); });
    $(id + '-less').addEventListener('click', function () { queueAppearance(key, appearanceValue(key) - 0.05); });
    $(id + '-more').addEventListener('click', function () { queueAppearance(key, appearanceValue(key) + 0.05); });
  });
  $('appearance-reset').addEventListener('click', function () {
    Object.keys(appearanceFields).filter(function (key) { return key !== 'kenBurnsSpeed'; }).forEach(function (key) { queueAppearance(key, appearanceFields[key].fallback); });
  });
  $('wallpaper-video').addEventListener('playing', function () { if (!document.hidden && !state.videoFailed) $('wallpaper-video').hidden = false; });
  $('wallpaper-video').addEventListener('error', videoFailure);
  $('wallpaper-image').addEventListener('load', updatePhotoMotion);
  $('wallpaper-image').addEventListener('error', function () {
    if ($('wallpaper-image').getAttribute('src') !== 'wallpaper.jpg') { $('wallpaper-image').src = 'wallpaper.jpg'; toast('The wallpaper could not load. Showing the included photo.'); }
  });
  document.querySelector('.tabs').setAttribute('role','tablist');
  tabNames.forEach(function(name){
    var tab=document.querySelector('[data-tab="'+name+'"]'), panel=$('section-'+name);
    tab.id='tab-'+name;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',panel.id);tab.setAttribute('aria-selected',String(name===state.tab));
    panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);
  });
  document.addEventListener('click',function(event){
    if(focusScope()!==$('home')&&!focusScope().contains(event.target)){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  document.addEventListener('focusin',function(event){
    var scope=focusScope(),groups=nav.rows(scope),key=focusKey();
    if(!scope.contains(event.target)){var first=candidates()[0];if(first)first.focus({preventScroll:true});return;}
    groups.some(function(row,index){var column=row.indexOf(event.target);if(column<0)return false;focusSnapshot={key:key,row:index,column:column};return true;});
    if(state.settings && $('section-'+state.tab).contains(event.target)){
      state.tabMemory[state.tab]=state.tabMemory[state.tab]||{};state.tabMemory[state.tab].key=key;
    }
  });
  document.addEventListener('keyboardStateChange',function(event){state.keyboardVisible=!!(event.detail&&event.detail.visibility);});
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerdown', pointerFocus);
  document.addEventListener('mousemove', pointerFocus);
  document.addEventListener('cursorStateChange', function (event) {
    var details = event.detail || {};
    if (typeof details.visibility === 'boolean') document.documentElement.setAttribute('data-input-mode', details.visibility ? 'pointer' : 'keys');
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopVideo(); updatePhotoMotion(); }
    else { restoreNativeCursor(); setWallpaper(); updateClock(); pollState(); fetchWeather(false); }
  });
  window.addEventListener('focus', restoreNativeCursor);
  window.addEventListener('resize', updatePhotoMotion);
  window.addEventListener('resize', renderFocalEditor);
  window.addEventListener('pagehide', function () { stopVideo(); stopPhotoMotion(); });
  if (reducedMotion) {
    if (typeof reducedMotion.addEventListener === 'function') reducedMotion.addEventListener('change', updatePhotoMotion);
    else if (typeof reducedMotion.addListener === 'function') reducedMotion.addListener(updatePhotoMotion);
  }
  restoreNativeCursor();
  updateClock();
  setInterval(function () { if (!document.hidden) updateClock(); }, 1000);
  setInterval(pollState, 5000);
  setInterval(function () { fetchWeather(false); }, 60000);
  connect();
}());
