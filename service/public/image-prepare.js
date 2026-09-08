(function (root) {
  'use strict';

  var HEADER_BYTES = 1024 * 1024;
  var MAX_INPUT_PIXELS = 64000000;
  var MAX_FILE_BYTES = 150 * 1024 * 1024;

  function canceledError() {
    var error = new Error('Photo preparation canceled. Nothing was uploaded.');
    error.name = 'AbortError';
    return error;
  }

  function check(options) {
    if (options.isCanceled && options.isCanceled()) throw canceledError();
  }

  function bounded(promise, options, message) {
    return new Promise(function (resolve, reject) {
      var finished = false;
      var interval;
      var timeout;
      function finish(error, value) {
        if (finished) return;
        finished = true;
        clearInterval(interval);
        clearTimeout(timeout);
        if (error) reject(error); else resolve(value);
      }
      interval = setInterval(function () {
        try { check(options); } catch (error) { finish(error); }
      }, 40);
      timeout = setTimeout(function () { finish(new Error(message)); }, 45000);
      Promise.resolve(promise).then(function (value) {
        try { check(options); finish(null, value); } catch (error) { finish(error); }
      }, function (error) { finish(error); });
    });
  }

  function readHeader(file, options) {
    var slice = file.slice(0, HEADER_BYTES);
    if (slice.arrayBuffer) return bounded(slice.arrayBuffer(), options, 'Reading this photo took too long. Please try a smaller photo.').then(function (buffer) { return new Uint8Array(buffer); });
    return bounded(new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(new Error('This photo could not be read. Please choose it again.')); };
      reader.readAsArrayBuffer(slice);
    }), options, 'Reading this photo took too long. Please try a smaller photo.');
  }

  async function prepare(file, options) {
    options = options || {};
    var image = null;
    var objectURL = '';
    var canvas = null;
    try {
      check(options);
      if (!root.StillImageInfo || typeof root.StillImageInfo.inspect !== 'function') throw new Error('Photo preparation could not load. Refresh this page and try again.');
      if (!file || !file.size || file.size > MAX_FILE_BYTES) throw new Error('Choose a photo smaller than 150 MB.');
      if (!/\.(jpe?g|png|webp)$/i.test(file.name || '')) throw new Error('Choose a JPG, PNG or WebP photo. Use MP4 for animated wallpapers.');
      var info = root.StillImageInfo.inspect(await readHeader(file, options), file.size);
      check(options);
      if (info.animated) throw new Error('Animated WebP and PNG photos cannot be resized here. Use an MP4 video to keep the animation.');
      if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1 || info.width * info.height > MAX_INPUT_PIXELS) throw new Error('This photo is larger than 64 megapixels. Export a smaller copy and choose that copy.');
      if (['image/jpeg', 'image/png', 'image/webp'].indexOf(info.mime) === -1) throw new Error('Choose a JPG, PNG or WebP photo.');
      var turned = info.orientation >= 5 && info.orientation <= 8;
      var width = turned ? info.height : info.width;
      var height = turned ? info.width : info.height;
      var target = root.StillImageInfo.targetSize(width, height);
      if (!target || !Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height) || target.width < 1 || target.height < 1 || target.width > 4096 || target.height > 4096 || target.width * target.height > 9000000 || target.width > width || target.height > height) throw new Error('This photo could not be sized safely. Please choose another photo.');

      image = new Image();
      image.decoding = 'async';
      objectURL = URL.createObjectURL(file);
      var loaded = new Promise(function (resolve, reject) {
        image.onload = resolve;
        image.onerror = function () { reject(new Error('This photo could not be decoded. Export it as a JPG or PNG and try again.')); };
      });
      image.src = objectURL;
      await bounded(loaded, options, 'Preparing this photo took too long. Try a smaller photo.');
      if (typeof image.decode === 'function') {
        await bounded(image.decode().catch(function () { throw new Error('This photo could not be decoded. Export it as a JPG or PNG and try again.'); }), options, 'Preparing this photo took too long. Try a smaller photo.');
      }
      check(options);
      // HTML image decoding applies EXIF orientation, including mirrored photos.
      // Verify the oriented dimensions before drawing; never apply EXIF twice.
      if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('This browser could not read the photo’s orientation correctly. Export a new JPG copy and try again.');
      canvas = document.createElement('canvas');
      canvas.width = target.width;
      canvas.height = target.height;
      var outputType = info.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      var context = canvas.getContext('2d', { alpha: outputType !== 'image/jpeg' });
      if (!context || typeof canvas.toBlob !== 'function') throw new Error('This browser cannot prepare photos. Try a current Safari or Chrome browser.');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, target.width, target.height);
      check(options);
      var blob = await bounded(new Promise(function (resolve, reject) {
        canvas.toBlob(function (result) {
          if (!result || !result.size) reject(new Error('The resized photo could not be created. Try a smaller photo.'));
          else resolve(result);
        }, outputType, 0.90);
      }), options, 'Saving the resized photo took too long. Try a smaller photo.');
      check(options);
      if (blob.type !== outputType || blob.size > MAX_FILE_BYTES) throw new Error('The resized photo could not be saved in the right format. Try a smaller JPG photo.');
      var outputInfo = root.StillImageInfo.inspect(await readHeader(blob, options), blob.size);
      if (outputInfo.width !== target.width || outputInfo.height !== target.height || outputInfo.animated || outputInfo.orientation !== 1) throw new Error('The resized photo did not pass its final check. Please choose another photo.');
      check(options);
      var name = String(file.name).replace(/\.(jpe?g|png|webp)$/i, '').replace(/[\x00-\x1f/\\]/g, '_').slice(0, 180) || 'wallpaper';
      return { blob: blob, name: name + '-tv' + (outputType === 'image/jpeg' ? '.jpg' : '.png'), width: target.width, height: target.height, originalSize: file.size };
    } finally {
      if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); }
      if (objectURL) URL.revokeObjectURL(objectURL);
      if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
  }

  root.StillImagePrepare = { prepare: prepare };
}(window));
