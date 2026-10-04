(function () {
  var HYBRID_PREFIX = "E";
  var HYBRID_SUFFIX = "AQI";

  function log() {
    try { console.log.apply(console, arguments); } catch (_) {}
  }

  function notifyOnce(index) {
    try {
      var key = "NextinWeatherHybridLabelV1";
      var seen = false;
      if (typeof $persistentStore !== "undefined") {
        seen = $persistentStore.read(key) === "1";
        if (!seen) $persistentStore.write("1", key);
      } else if (typeof $prefs !== "undefined") {
        seen = $prefs.valueForKey(key) === "1";
        if (!seen) $prefs.setValueForKey("1", key);
      }
      if (!seen) {
        var msg = "欧盟 EAQI 等级保持不变；附加数值：" + index;
        if (typeof $notification !== "undefined") $notification.post("WeatherKit Hybrid AQI", "实验模式已命中", msg);
        else if (typeof $notify === "function") $notify("WeatherKit Hybrid AQI", "实验模式已命中", msg);
      }
    } catch (_) {}
  }

  function toU8(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function i32(view, pos) { return view.getInt32(pos, true); }
  function u32(view, pos) { return view.getUint32(pos, true); }
  function u16(view, pos) { return view.getUint16(pos, true); }

  // FlatBuffers table field position. vtableOffset is 4 + fieldIndex*2.
  function fieldPos(bytes, tablePos, vtableOffset) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (tablePos < 0 || tablePos + 4 > bytes.byteLength) return -1;
    var vtablePos = tablePos - i32(view, tablePos);
    if (vtablePos < 0 || vtablePos + 4 > bytes.byteLength) return -1;
    var vtableLen = u16(view, vtablePos);
    if (vtableOffset >= vtableLen || vtablePos + vtableOffset + 2 > bytes.byteLength) return -1;
    var off = u16(view, vtablePos + vtableOffset);
    if (!off) return -1;
    var p = tablePos + off;
    return p < bytes.byteLength ? p : -1;
  }

  function locateAirQualityTable(bytes) {
    if (!bytes || bytes.byteLength < 12) return -1;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var rootPos = u32(view, 0);
    if (rootPos <= 0 || rootPos >= bytes.byteLength) return -1;

    // Weather.airQuality = field 0 => vtable offset 4.
    var aqField = fieldPos(bytes, rootPos, 4);
    if (aqField < 0 || aqField + 4 > bytes.byteLength) return -1;
    var aqTable = aqField + u32(view, aqField);
    return (aqTable > 0 && aqTable < bytes.byteLength) ? aqTable : -1;
  }

  function readIndex(bytes) {
    var aqTable = locateAirQualityTable(bytes);
    if (aqTable < 0) return null;
    // AirQuality.index = field 2 => vtable offset 8.
    var p = fieldPos(bytes, aqTable, 8);
    if (p < 0 || p + 2 > bytes.byteLength) return null;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(p, true);
  }

  function makeHybridScale(index) {
    var n = Math.max(0, Math.min(999, Math.round(Number(index) || 0)));
    var digits = String(n);
    while (digits.length < 3) digits = "0" + digits;
    return HYBRID_PREFIX + digits + HYBRID_SUFFIX; // 7 ASCII chars, same as EU.EAQI.
  }

  function patchScaleId(bytes, hybridScale) {
    var aqTable = locateAirQualityTable(bytes);
    if (aqTable < 0) return false;

    // AirQuality.scale = field 7 => vtable offset 18.
    var scaleField = fieldPos(bytes, aqTable, 18);
    if (scaleField < 0 || scaleField + 4 > bytes.byteLength) return false;

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var stringPos = scaleField + u32(view, scaleField);
    if (stringPos < 0 || stringPos + 4 > bytes.byteLength) return false;

    var len = u32(view, stringPos);
    if (len !== 7 || stringPos + 4 + len > bytes.byteLength || hybridScale.length !== 7) return false;

    var current = "";
    for (var i = 0; i < len; i++) current += String.fromCharCode(bytes[stringPos + 4 + i]);
    if (current !== "EU.EAQI") {
      log("WeatherHybrid: current scale is not EU.EAQI:", current);
      return false;
    }

    for (var j = 0; j < 7; j++) bytes[stringPos + 4 + j] = hybridScale.charCodeAt(j);
    return true;
  }

  function buildCnUrl(originalUrl) {
    var url = String(originalUrl || "");
    url = url.replace(/^https?:\/\/weatherkit\.apple\.com/i, "https://weatherkit.pages.dev");
    var sep = url.indexOf("?") >= 0 ? "&" : "?";
    return url + sep +
      "AirQuality.Calculate.Algorithm=WAQI_InstantCast_CN" +
      "&AirQuality.Current.Index.Provider=Calculate" +
      "&Storage=Argument";
  }

  function cleanHeaders(headers) {
    var out = {};
    headers = headers || {};
    Object.keys(headers).forEach(function (k) {
      var lk = k.toLowerCase();
      if (lk === "host" || lk === "content-length" || lk === "connection") return;
      out[k] = headers[k];
    });
    return out;
  }

  function fetchBytes(url, headers) {
    if (typeof $task !== "undefined" && $task && typeof $task.fetch === "function") {
      return $task.fetch({
        url: url,
        method: "GET",
        headers: cleanHeaders(headers),
        "binary-mode": true
      }).then(function (resp) {
        return toU8(resp && (resp.bodyBytes || resp.body));
      });
    }

    return new Promise(function (resolve, reject) {
      if (typeof $httpClient === "undefined") {
        reject(new Error("No supported HTTP client"));
        return;
      }
      $httpClient.get({
        url: url,
        headers: cleanHeaders(headers),
        "binary-mode": true
      }, function (err, resp, data) {
        if (err) {
          reject(err);
          return;
        }
        resolve(toU8((resp && resp.bodyBytes) || data || (resp && resp.body)));
      });
    });
  }

  function indexFromScaleRequest(url) {
    var s = String(url || "");
    var m = s.match(/\/E([0-9]{3})AQI(?:\.|\/|\?|$)/i);
    if (m) return parseInt(m[1], 10);
    try {
      var q = s.match(/[?&]HybridIndex=([0-9]{1,3})(?:&|$)/i);
      if (q) return parseInt(q[1], 10);
    } catch (_) {}
    return null;
  }

  function patchScaleJson(body, reqUrl) {
    if (typeof body !== "string" || !body.length) return null;
    var index = indexFromScaleRequest(reqUrl);
    if (index === null) return null;

    var obj = JSON.parse(body);
    if (!obj || !obj.aqi || !Array.isArray(obj.aqi.categories)) return null;

    var hybridScale = makeHybridScale(index);
    obj.name = hybridScale;
    obj.aqi.categories = obj.aqi.categories.map(function (category) {
      var c = {};
      Object.keys(category).forEach(function (k) { c[k] = category[k]; });
      var originalName = String(category.categoryName || "");
      // Only show the number; do not add "中国 AQI" text.
      c.categoryName = String(index) + " " + originalName;
      return c;
    });
    return JSON.stringify(obj);
  }

  try {
    var reqUrl = typeof $request !== "undefined" ? String($request.url || "") : "";
    var resp = typeof $response !== "undefined" ? $response : {};

    // Custom EU scale alias response: same EU scale, only category label gets the CN number.
    if (/\/api\/v1\/airQualityScale\//i.test(reqUrl)) {
      try {
        var patchedJson = patchScaleJson(resp.body, reqUrl);
        if (patchedJson) {
          var headers = {};
          Object.keys(resp.headers || {}).forEach(function (k) {
            if (k.toLowerCase() !== "content-length") headers[k] = resp.headers[k];
          });
          headers["Cache-Control"] = "no-store";
          $done({ body: patchedJson, headers: headers });
          return;
        }
      } catch (e) {
        log("WeatherHybrid scale label patch failed:", String(e));
      }
      $done({});
      return;
    }

    // Main WeatherKit v2 response:
    // fetch one CN-HJ6332012 copy only to obtain its number,
    // then change ONLY the EU scale identifier to a same-length alias.
    // EU index/category/colour/health advice remain untouched.
    if (/\/api\/v2\/weather\//i.test(reqUrl)) {
      var euBytes = toU8(resp.bodyBytes);
      if (!euBytes) {
        log("WeatherHybrid: no binary response body");
        $done({});
        return;
      }

      var cnUrl = buildCnUrl(reqUrl);
      fetchBytes(cnUrl, typeof $request !== "undefined" ? $request.headers : {})
        .then(function (cnBytes) {
          if (!cnBytes) throw new Error("CN fetch returned no binary body");
          var cnIndex = readIndex(cnBytes);
          if (cnIndex === null) throw new Error("Could not locate CN AQI index");

          var hybridScale = makeHybridScale(cnIndex);
          if (!patchScaleId(euBytes, hybridScale)) {
            throw new Error("EU scale alias patch failed");
          }

          log("WeatherHybrid: EU scale preserved, label index=" + cnIndex + ", alias=" + hybridScale);
          notifyOnce(cnIndex);
          $done({ bodyBytes: euBytes });
        })
        .catch(function (e) {
          log("WeatherHybrid main patch failed:", String(e));
          $done({});
        });
      return;
    }

    $done({});
  } catch (e) {
    log("WeatherHybrid fatal:", String(e));
    $done({});
  }
})();