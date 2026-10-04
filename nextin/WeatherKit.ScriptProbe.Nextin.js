(function () {
  try {
    var url = (typeof $request !== "undefined" && $request.url) ? String($request.url) : "unknown";
    var status = (typeof $response !== "undefined" && ($response.status || $response.statusCode)) || "unknown";
    var msg = "URL: " + url + "\nStatus: " + status;
    try { console.log("WeatherKit Script Probe\n" + msg); } catch (_) {}
    try {
      if (typeof $notification !== "undefined") {
        $notification.post("WeatherKit Script Probe", "Nextin 脚本已命中", msg);
      } else if (typeof $notify === "function") {
        $notify("WeatherKit Script Probe", "Nextin 脚本已命中", msg);
      }
    } catch (_) {}
  } catch (_) {
  } finally {
    $done({});
  }
})();