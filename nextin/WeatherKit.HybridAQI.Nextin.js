(function () {
  function log() {
    try { console.log.apply(console, arguments); } catch (_) {}
  }

  function notifyOnce(title, subtitle, body) {
    try {
      var key = "NextinWeatherHybridV1Notified";
      var seen = false;
      if (typeof $persistentStore !== "undefined") {
        seen = $persistentStore.read(key) === "1";
        if (!seen) $persistentStore.write("1", key);
      } else if (typeof $prefs !== "undefined") {
        seen = $prefs.valueForKey(key) === "1";
        if (!seen) $prefs.setValueForKey("1", key);
      }
      if (!seen) {
        if (typeof $notification !== "undefined") $notification.post(title, subtitle, body);
        else if (typeof $notify === "function") $notify(title, subtitle, body);
      }
    } catch (_) {}
  }

  function toU8(value) {
    if (!value) return null;
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function i32(view, pos) { return view.getInt32(pos, true); }
  function u32(view, pos) { return view.getUint32(pos, true); }
  function u16(view, pos) { return view.getUint16(pos, true); }

  // FlatBuffers: return absolute position of a table field, or -1.
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

  // Weather.airQuality = root field #0 => vtable offset 4.
  // AirQuality.index = field #2 => vtable offset 8, int16.
  function locateAirQualityIndex(bytes) {
    if (!bytes || bytes.byteLength < 12) return -1;
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var rootPos = u32(view, 0);
    if (rootPos <= 0 || rootPos >= bytes.byteLength) return -1;
    var aqField = fieldPos(bytes, rootPos, 4);
    if (aqField < 0 || aqField + 4 > bytes.byteLength) return -1;
    var aqTable = aqField + u32(view, aqField);
    if (aqTable <= 0 || aqTable >= bytes.byteLength) return -1;
    return fieldPos(bytes, aqTable, 8);
  }

  function readIndex(bytes) {
    var p = locateAirQualityIndex(bytes);
    if (p < 0 || p + 2 > bytes.byteLength) return null;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(p, true);
  }

  function writeIndex(bytes, value) {
    var p = locateAirQualityIndex(bytes);
    if (p < 0 || p + 2 > bytes.byteLength) return false;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt16(p, value, true);
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

  try {
    var reqUrl = typeof $request !== "undefined" ? String($request.url || "") : "";
    var resp = typeof $response !== "undefined" ? $response : {};

    // JSON scale response: tell Weather that EAQI is numerical, while keeping
    // its EU categories/labels/recommendations intact.
    if (/\/api\/v1\/airQualityScale\//i.test(reqUrl)) {
      try {
        var body = resp.body;
        if (typeof body === "string" && body.length) {
          var obj = JSON.parse(body);
          if (obj && obj.aqi) {
            obj.aqi.numerical = true;
            $done({ body: JSON.stringify(obj) });
            return;
          }
        }
      } catch (e) {
        log("WeatherHybrid scale patch failed:", String(e));
      }
      $done({});
      return;
    }

    // Binary WeatherKit v2 response: preserve EU scale/category, replace only
    // the numeric index with a China HJ6332012 calculation from a second fetch.
    if (/\/api\/v2\/weather\//i.test(reqUrl)) {
      var euBytes = toU8(resp.bodyBytes);
      if (!euBytes) {
        log("WeatherHybrid: no binary response body");
        $done({});
        return;
      }

      var euIndex = readIndex(euBytes);
      var cnUrl = buildCnUrl(reqUrl);
      fetchBytes(cnUrl, typeof $request !== "undefined" ? $request.headers : {})
        .then(function (cnBytes) {
          if (!cnBytes) throw new Error("CN fetch returned no binary body");
          var cnIndex = readIndex(cnBytes);
          if (cnIndex === null) throw new Error("Could not locate CN AQI index");
          if (!writeIndex(euBytes, cnIndex)) throw new Error("Could not patch EU index field");

          log("WeatherHybrid patched index EU=" + euIndex + " -> CN=" + cnIndex);
          notifyOnce(
            "WeatherKit Hybrid AQI",
            "实验混合模式已命中",
            "欧盟等级保留；显示数值已替换为 " + cnIndex
          );
          $done({ bodyBytes: euBytes });
        })
        .catch(function (e) {
          log("WeatherHybrid binary patch failed:", String(e));
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