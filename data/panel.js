// emit events on the panel's port for corresponding actions
var countThreadHangs = document.getElementById("countThreadHangs");
var countEventLoopLags = document.getElementById("countEventLoopLags");
countThreadHangs.addEventListener("click", function() {
  self.port.emit("mode-changed", "threadHangs");
});
countEventLoopLags.addEventListener("click", function() {
  self.port.emit("mode-changed", "eventLoopLags");
});
var hangThreshold = document.getElementById("hangThreshold");
hangThreshold.addEventListener("input", function() {
  var value = parseInt(hangThreshold.value);
  if (!isNaN(value)) {
    self.port.emit("hang-threshold-changed", value);
  }
});
var clearCount = document.getElementById("clearCount");
clearCount.addEventListener("click", function() {
  self.port.emit("clear-count");
});

// listen to re-emitted show event from main script
self.port.on("show", function(currentSettings) {
  // populate the settings dialog with the current value of the settings
  document.getElementById("hangThreshold").value = currentSettings.hangThreshold;
  switch (currentSettings.mode) {
    case "threadHangs":
      document.getElementById("countThreadHangs").checked = true;
      break;
    case "eventLoopLags":
      document.getElementById("countEventLoopLags").checked = true;
      break;
    default:
      console.warn("Unknown mode: ", currentSettings.mode);
  }
});
