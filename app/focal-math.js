(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StillHomeFocal = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function dimension(value, name) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(name + ' must be a positive number.');
    return value;
  }
  function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
  function dimensions(options) {
    return {
      iw: dimension(options.imageWidth, 'imageWidth'),
      ih: dimension(options.imageHeight, 'imageHeight'),
      vw: dimension(options.viewportWidth, 'viewportWidth'),
      vh: dimension(options.viewportHeight, 'viewportHeight')
    };
  }
  function containRect(options) {
    var d = dimensions(options);
    var scale = Math.min(d.vw / d.iw, d.vh / d.ih);
    var width = d.iw * scale;
    var height = d.ih * scale;
    return {left: (d.vw - width) / 2, top: (d.vh - height) / 2, width: width, height: height, scale: scale};
  }
  function pointFromClient(options) {
    var rect = options.rect;
    var contained = containRect({
      imageWidth: options.imageWidth, imageHeight: options.imageHeight,
      viewportWidth: rect.width, viewportHeight: rect.height
    });
    var x = options.clientX - rect.left - contained.left;
    var y = options.clientY - rect.top - contained.top;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > contained.width || y > contained.height) return null;
    return {x: clamp(x / contained.width, 0, 1), y: clamp(y / contained.height, 0, 1)};
  }
  function computeFrame(options) {
    var d = dimensions(options);
    var point = options.point === undefined ? null : options.point;
    if (point !== null && (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
      throw new RangeError('Focal point must use coordinates from 0 to 1.');
    }
    var zoom = options.zoom === undefined ? 1 : options.zoom;
    if (!Number.isFinite(zoom) || zoom < 1) throw new RangeError('zoom must be at least 1.');
    var cover = Math.max(d.vw / d.iw, d.vh / d.ih);
    var baseWidth = d.iw * cover;
    var baseHeight = d.ih * cover;
    var baseLeft = point ? clamp(d.vw / 2 - point.x * baseWidth, d.vw - baseWidth, 0) : (d.vw - baseWidth) / 2;
    var baseTop = point ? clamp(d.vh / 2 - point.y * baseHeight, d.vh - baseHeight, 0) : 0;
    var anchorX = point ? baseLeft + point.x * baseWidth : d.vw / 2;
    var anchorY = point ? baseTop + point.y * baseHeight : 0;
    var centered = !!point && Math.abs(anchorX - d.vw / 2) < 0.01 && Math.abs(anchorY - d.vh / 2) < 0.01;
    return {
      left: anchorX + (baseLeft - anchorX) * zoom,
      top: anchorY + (baseTop - anchorY) * zoom,
      width: baseWidth * zoom, height: baseHeight * zoom, scale: cover * zoom,
      baseLeft: baseLeft, baseTop: baseTop, baseWidth: baseWidth, baseHeight: baseHeight,
      coverScale: cover, zoom: zoom,
      objectPosition: {
        x: baseWidth - d.vw > 0.0001 ? clamp(-baseLeft / (baseWidth - d.vw) * 100, 0, 100) : 50,
        y: baseHeight - d.vh > 0.0001 ? clamp(-baseTop / (baseHeight - d.vh) * 100, 0, 100) : 0
      },
      anchor: {x: anchorX, y: anchorY},
      anchorPercent: {x: anchorX / d.vw * 100, y: anchorY / d.vh * 100},
      centered: centered, clamped: !!point && !centered,
      framingLabel: point ? (centered ? 'Centered' : 'Near edge · fixed') : 'Original top framing'
    };
  }
  return {computeFrame: computeFrame, containRect: containRect, pointFromClient: pointFromClient};
}));
