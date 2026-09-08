(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StillImageInfo = factory();
}(typeof window === 'object' ? window : this, function () {
  'use strict';
  var HEADER_BYTES = 1024 * 1024;
  var MAX_PIXELS = 9000000;
  var MAX_SIDE = 4096;
  function invalid() { throw new Error('This photo has an invalid or unsupported image header. Please export it as a new JPG or PNG.'); }
  function inspect(bytes, totalSize) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 12 || !Number.isSafeInteger(totalSize) || totalSize < bytes.length) invalid();
    var b = bytes.subarray(0, HEADER_BYTES), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    function need(p, n) { if (p < 0 || n < 0 || p + n > b.length) invalid(); }
    function u16(p, le) { need(p, 2); return view.getUint16(p, Boolean(le)); }
    function u32(p, le) { need(p, 4); return view.getUint32(p, Boolean(le)); }
    function u24(p) { need(p, 3); return b[p] + b[p + 1] * 256 + b[p + 2] * 65536; }
    function str(p, n) { need(p, n); var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(b[p + i]); return s; }
    function result(w, h, mime, animated, orientation) {
      if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1) invalid();
      return { width: w, height: h, mime: mime, animated: Boolean(animated), orientation: orientation || 1 };
    }
    if (b[0] === 255 && b[1] === 216) {
      var p = 2, width = 0, height = 0, frameComponents = 0, orientation = 1, seenExif = false;
      while (p < b.length) {
        if (b[p++] !== 255) invalid();
        while (b[p] === 255) p++;
        need(p, 1); var marker = b[p++];
        if (marker === 0 || marker === 216 || marker === 217) invalid();
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        var length = u16(p); if (length < 2) invalid(); need(p, length);
        var start = p + 2, end = p + length;
        if (marker === 225 && length >= 8 && str(start, 6) === 'Exif\x00\x00') {
          if (seenExif) invalid(); seenExif = true;
          var t = start + 6; if (t + 8 > end) invalid();
          var order = str(t, 2); if (order !== 'II' && order !== 'MM') invalid();
          var little = order === 'II'; if (u16(t + 2, little) !== 42) invalid();
          var ifd = t + u32(t + 4, little); if (ifd < t + 8 || ifd + 2 > end) invalid();
          var count = u16(ifd, little); if (ifd + 2 + count * 12 + 4 > end) invalid();
          for (var e = 0; e < count; e++) {
            var entry = ifd + 2 + e * 12;
            if (u16(entry, little) === 274) {
              if (u16(entry + 2, little) !== 3 || u32(entry + 4, little) !== 1) invalid();
              orientation = u16(entry + 8, little); if (orientation < 1 || orientation > 8) invalid();
            }
          }
        }
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].indexOf(marker) !== -1) {
          if (width || length < 8) invalid();
          height = u16(start + 1); width = u16(start + 3);
          frameComponents = b[start + 5];
          if (frameComponents < 1 || frameComponents > 4 || length !== 8 + frameComponents * 3) invalid();
        }
        if (marker === 218) {
          if (!width || !height || length < 6 || end >= totalSize) invalid();
          var scanComponents = b[start];
          if (scanComponents < 1 || scanComponents > frameComponents || length !== 6 + scanComponents * 2) invalid();
          return result(width, height, 'image/jpeg', false, orientation);
        }
        p = end;
      }
      invalid();
    }
    if (str(0, 8) === '\x89PNG\r\n\x1a\n') {
      if (u32(8) !== 13 || str(12, 4) !== 'IHDR') invalid();
      need(16, 17);
      var pw = u32(16), ph = u32(20), animated = false;
      var depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[b[25]] || depths[b[25]].indexOf(b[24]) === -1) invalid();
      if (b[26] !== 0 || b[27] !== 0 || b[28] > 1) invalid();
      var pos = 33;
      while (pos + 8 <= b.length) {
        var len = u32(pos), type = str(pos + 4, 4);
        if (pos + 12 + len > totalSize) invalid();
        if (type === 'IDAT') return result(pw, ph, 'image/png', animated);
        if (type === 'acTL') { if (len !== 8) invalid(); animated = true; }
        if (type === 'IEND' || type === 'IHDR') invalid();
        need(pos, 12 + len); pos += 12 + len;
      }
      invalid();
    }
    if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') {
      var riffEnd = u32(4, true) + 8;
      if (riffEnd !== totalSize) invalid();
      var q = 12, canvasWidth = 0, canvasHeight = 0;
      while (q + 8 <= b.length) {
        var tag = str(q, 4), chunkLength = u32(q + 4, true), data = q + 8;
        if (data + chunkLength + (chunkLength % 2) > riffEnd) invalid();
        if (tag === 'VP8X') {
          if (q !== 12 || chunkLength !== 10) invalid(); need(data, 10);
          canvasWidth = u24(data + 4) + 1; canvasHeight = u24(data + 7) + 1;
          if (b[data] & 2) return result(canvasWidth, canvasHeight, 'image/webp', true);
        } else if (tag === 'ANIM' || tag === 'ANMF') {
          return result(canvasWidth, canvasHeight, 'image/webp', true);
        } else if (tag === 'VP8 ' || tag === 'VP8L') {
          var ww, wh;
          if (tag === 'VP8 ') {
            if (chunkLength < 10) invalid(); need(data, 10);
            if ((b[data] & 1) || str(data + 3, 3) !== '\x9d\x01\x2a') invalid();
            ww = u16(data + 6, true) & 16383; wh = u16(data + 8, true) & 16383;
          } else {
            if (chunkLength < 5) invalid(); need(data, 5); if (b[data] !== 47 || (b[data + 4] >> 5) !== 0) invalid();
            ww = 1 + b[data + 1] + ((b[data + 2] & 63) << 8);
            wh = 1 + (b[data + 2] >> 6) + (b[data + 3] << 2) + ((b[data + 4] & 15) << 10);
          }
          if (canvasWidth && (ww !== canvasWidth || wh !== canvasHeight)) invalid();
          return result(ww, wh, 'image/webp', false);
        }
        need(q, 8 + chunkLength + (chunkLength % 2)); q = data + chunkLength + (chunkLength % 2);
      }
      invalid();
    }
    invalid();
  }
  function targetSize(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
    var scale = Math.min(1, Math.max(2400 / width, 1350 / height), MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  }
  return { inspect: inspect, targetSize: targetSize, HEADER_BYTES: HEADER_BYTES, MAX_PIXELS: MAX_PIXELS, MAX_SIDE: MAX_SIDE, MAX_INPUT_PIXELS: 64000000 };
}));
