(function () {
  try {
    var response = typeof $response === "undefined" ? {} : $response;
    var headers = response.headers || {};
    var kind = function (value) {
      return Object.prototype.toString.call(value);
    };
    var message = "body=" + kind(response.body) +
      "\nbytes=" + kind(response.bodyBytes) +
      "\ntask=" + typeof $task + ",prefs=" + typeof $prefs +
      ",store=" + typeof $persistentStore +
      "\nencoding=" + (headers["content-encoding"] || headers["Content-Encoding"] || "none") +
      "\ntype=" + (headers["content-type"] || headers["Content-Type"] || "unknown");
    try { console.log("NextinYTProbeRawV2\n" + message); } catch (ignore) {}
    var seen = false;
    var key = "NextinYTProbeRawV2";
    try {
      if (typeof $persistentStore !== "undefined") {
        seen = $persistentStore.read(key) === "1";
        if (!seen) $persistentStore.write("1", key);
      } else if (typeof $prefs !== "undefined") {
        seen = $prefs.valueForKey(key) === "1";
        if (!seen) $prefs.setValueForKey("1", key);
      }
    } catch (ignore) {}
    try {
      if (!seen && typeof $notification !== "undefined") {
        $notification.post("Nextin YT Raw Probe", "Response types only", message);
      } else if (!seen && typeof $notify === "function") {
        $notify("Nextin YT Raw Probe", "Response types only", message);
      }
    } catch (ignore) {}
  } catch (ignore) {
  } finally {
    $done({});
  }
})();
