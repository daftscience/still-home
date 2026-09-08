(function () {
  'use strict';
  var banner = document.getElementById('home-screen-card');
  var footer = document.getElementById('home-screen-footer');
  var dismiss = document.getElementById('home-screen-dismiss');
  var prefix = 'stillhome.ui.';
  var flight = null;
  function read(key) { try { return localStorage.getItem(prefix + key); } catch (_) { return null; } }
  function write(key, value) { try { localStorage.setItem(prefix + key, value); } catch (_) {} }
  function reduced() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function cleanup() { if (flight) { flight.remove(); flight = null; } }
  function showBanner(show) {
    banner.hidden = !show;
    footer.setAttribute('aria-expanded', String(show));
    footer.classList.toggle('docked', !show);
  }
  showBanner(read('homeBannerDismissed') !== '1');
  dismiss.addEventListener('click', function () {
    cleanup();
    var start = banner.getBoundingClientRect();
    write('homeBannerDismissed', '1');
    showBanner(false);
    footer.focus({preventScroll: true});
    if (reduced() || !footer.animate) return;
    var end = footer.getBoundingClientRect();
    var ghost = document.createElement('div');
    ghost.className = 'banner-flight';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = '◒ Keep Still Home close';
    ghost.style.left = start.left + 'px';
    ghost.style.top = Math.max(0, start.top) + 'px';
    ghost.style.width = start.width + 'px';
    document.body.appendChild(ghost); flight = ghost;
    var animation = ghost.animate([
      {transform:'translate(0,0) scale(1)',opacity:1},
      {transform:'translate('+(end.left-start.left)+'px,'+(end.top-Math.max(0,start.top))+'px) scale('+(end.width/start.width)+')',opacity:0.2}
    ], {duration:520,easing:'cubic-bezier(.3,0,.2,1)',fill:'forwards'});
    animation.onfinish = function () { if (flight === ghost) cleanup(); else ghost.remove(); };
    animation.oncancel = function () { ghost.remove(); };
  });
  footer.addEventListener('click', function () {
    cleanup(); showBanner(true);
    document.getElementById('install-help').open = true;
    banner.scrollIntoView({behavior:reduced()?'auto':'smooth',block:'start'});
    dismiss.focus({preventScroll:true});
  });
  Array.prototype.forEach.call(document.querySelectorAll('.collapsible-card'), function (section) {
    var key = 'section.' + section.id;
    var saved = read(key);
    if (saved !== null) section.open = saved === 'open';
    section.addEventListener('toggle', function () { write(key, section.open ? 'open' : 'closed'); });
  });
  window.addEventListener('storage', function (event) {
    if (event.key === prefix + 'homeBannerDismissed' && event.newValue === '1' && !banner.contains(document.activeElement)) showBanner(false);
  });
})();
