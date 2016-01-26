var self = require("sdk/self");
var ss = require("sdk/simple-storage");
var clipboard = require("sdk/clipboard");
var windowUtils = require("sdk/window/utils");

const {Cc, Ci, Cu} = require("chrome");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/TelemetrySession.jsm");
let gOS = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);

// load and validate settings
var gMode = ss.storage.mode;
if (["threadHangs", "eventLoopLags", "inputEventResponseLags"].indexOf(gMode) < 0) {
  gMode = "threadHangs";
}
var gPlaySound = ss.storage.playSound;
if (typeof gPlaySound !== "boolean") {
  gPlaySound = false;
}
var gHangThreshold = ss.storage.hangThreshold; // ms over which a bucket must start to be counted as a hang
if (typeof gHangThreshold !== "number" || gHangThreshold < 1) {
  gHangThreshold = 126;
}

const { setTimeout } = require("sdk/timers");
const { ActionButton } = require("sdk/ui/button/action");

// define all the SVG icons
const ANIMATE_TEMPLATE = '<!-- ANIMATE -->';
const ANIMATE_ROTATE_SVG = '' +
  '<animateTransform attributeName="transform" ' +
                    'attributeType="XML" ' +
                    'type="rotate" ' +
                    'from="0 60 70" ' +
                    'to="360 60 70" ' +
                    'dur="10s" ' +
                    'repeatCount="indefinite"/>';
const RED_SVG = 'data:image/svg+xml,' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
    '<rect width="100%" height="100%" fill="red">' +
      ANIMATE_TEMPLATE +
    '</rect>' +
  '</svg>';
const BLUE_CIRCLE_SVG = 'data:image/svg+xml,' +
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
    '<circle r="50%" cx="50%" cy="50%" fill="blue">' +
      ANIMATE_TEMPLATE +
    '</circle>' +
  '</svg>';
const YELLOW_SVG = RED_SVG.replace('red', 'yellow');

var mBaseSVG = RED_SVG;
var mAnimateSVG = '';

var button = ActionButton({
  id: "active-button",
  badge: 0,
  badgeColor: "red",
  label: "Statuser",
  icon: mBaseSVG.replace(ANIMATE_TEMPLATE, mAnimateSVG),
  onClick: showPanel,
});

function changeState(button, aBaseSVG, aAnimateSVG = mAnimateSVG) {
  mBaseSVG = aBaseSVG || mBaseSVG;
  mAnimateSVG = aAnimateSVG;
  button.state("window", {
    icon: mBaseSVG.replace(ANIMATE_TEMPLATE, mAnimateSVG),
  });
}

var panel = require("sdk/panel").Panel({
  contentURL: "./panel.html",
  contentScriptFile: "./panel.js",
  width: 500,
  height: 600,
});
function showPanel() {
  panel.show({position: button});
  panel.port.emit("show", { // emit event on the panel's port so the script inside knows it's shown
    playSound: gPlaySound,
    hangThreshold: gHangThreshold,
    mode: gMode,
  });
}

// switch modes between thread hang detection and event loop lag detection
panel.port.on("mode-changed", function(mode) {
  gMode = mode;
  ss.storage.mode = mode;
  clearCount();
});

// toggle notification sound on and off
panel.port.on("play-sound-changed", function(playSound) {
  gPlaySound = playSound;
  ss.storage.playSound = playSound;
});

// set the hang threshold
panel.port.on("hang-threshold-changed", function(hangThreshold) {
  gHangThreshold = hangThreshold;
  ss.storage.hangThreshold = hangThreshold;
});

// clear the hang counter
panel.port.on("clear-count", function() {
  clearCount();
});

// copy a value to the clipboard
panel.port.on("copy", function(value) {
  clipboard.set(value);
});

// the toolbar icon should be red while the user is active, and blue when not
gOS.addObserver({
  observe: function (subject, topic, data) {
    changeState(button, RED_SVG);
  }
}, "user-interaction-active", false);
gOS.addObserver({
  observe: function (subject, topic, data) {
    changeState(button, BLUE_CIRCLE_SVG);
  }
}, "user-interaction-inactive", false);

// show the spinning icon when any tabs are loading
var webProgressListener = {
  // see https://developer.mozilla.org/en-US/docs/Mozilla/Tech/XPCOM/Reference/Interface/nsIWebProgressListener#onStateChange%28%29
  onStateChange: function (aBrowser, aWebProgress, aRequest, aStateFlags, aStatus) {
    if (aWebProgress.isTopLevel && aStateFlags & Ci.nsIWebProgressListener.STATE_IS_WINDOW) {
      if (aStateFlags & Ci.nsIWebProgressListener.STATE_START) {
        changeState(button, YELLOW_SVG, ANIMATE_ROTATE_SVG);
      } else if (aStateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
        changeState(button, undefined, "");
      }
    }
  }
};
var gBrowser = windowUtils.getMostRecentBrowserWindow().getBrowser();
gBrowser.addTabsProgressListener(webProgressListener);

// function that retrieves the current child hangs and caches it for a short duration
// caching this is useful since each call has to go through the events queue
let cachedPreviousChildHangs = null;
let lastChildHangsRetrievedTime = -Infinity;
function getChildThreadHangs() {
  if (Date.now() - lastChildHangsRetrievedTime < 300) {
    return new Promise((resolve) => { resolve(cachedPreviousChildHangs); });
  }
  lastChildHangsRetrievedTime = Date.now();
  return TelemetrySession.getChildThreadHangs().then((hangs) => {
    cachedPreviousChildHangs = hangs;
    return hangs;
  });
}

// returns the number of Gecko hangs, and the computed minimum threshold for those hangs (which is a value >= gHangThreshold)
function getHangs() {
  switch(gMode) {
    case "threadHangs":
      return numGeckoThreadHangs();
    case "eventLoopLags":
      return numEventLoopLags();
    case "inputEventResponseLags":
      return numInputEventResponseLags();
    default:
      console.warn("Unknown mode: ", gMode);
      return new Promise((resolve) => {
        resolve({numHangs: null, minBucketLowerBound: 0});
      });
  }
}

function numGeckoThreadHangs(includeChildHangs = true) {
  if (includeChildHangs && !TelemetrySession.getChildThreadHangs) {
    panel.port.emit("warning", "unavailableChildBHR");
    return new Promise((resolve) => { resolve({numHangs: null, minBucketLowerBound: 0}); });
  }

  let geckoThread = Services.telemetry.threadHangStats.find(thread => thread.name == "Gecko");
  if (!geckoThread || !geckoThread.activity.counts) {
    panel.port.emit("warning", "unavailableBHR");
    return new Promise((resolve) => { resolve({numHangs: null, minBucketLowerBound: 0}); });
  }

  return new Promise((resolve) => {
    if (includeChildHangs) {
      getChildThreadHangs().then((hangs) => {
        // accumulate all of the counts in the child processes with the counts in the parent process
        let counts = geckoThread.activity.counts.slice(0);
        hangs.forEach((threadHangStats) => {
          let childGeckoThread = threadHangStats.find(thread => thread.name == "Gecko_Child");
          if (childGeckoThread && childGeckoThread.activity.counts) {
            childGeckoThread.activity.counts.forEach((count, i) => { counts[i] += count; });
          }
        });
        resolve(counts);
      });
    } else { // Just use the parent process stats
      resolve(geckoThread.activity.counts);
    }
  }).then((counts) => {
    // see the NOTE in mostRecentHangs() for caveats when using the activity.counts histogram
    // to summarize, the ranges are the inclusive upper bound of the histogram rather than the inclusive lower bound
    let numHangs = 0;
    let minBucketLowerBound = Infinity;
    counts.forEach((count, i) => {
      var lowerBound = geckoThread.activity.ranges[i - 1] + 1;
      if (lowerBound >= gHangThreshold) {
        numHangs += count;
        minBucketLowerBound = Math.min(minBucketLowerBound, lowerBound);
      }
    });
    panel.port.emit("warning", null);
    return {numHangs: numHangs, minBucketLowerBound: minBucketLowerBound};
  });
}

function numEventLoopLags() {
  return new Promise((resolve) => {
    try {
      var snapshot = Services.telemetry.getHistogramById("EVENTLOOP_UI_ACTIVITY_EXP_MS").snapshot();
    } catch (e) { // histogram doesn't exist, the Firefox version is likely older than 45.0a1
      panel.port.emit("warning", "unavailableEventLoopLags");
      resolve({numHangs: null, minBucketLowerBound: 0});
    }
    let numHangs = 0;
    let minBucketLowerBound = Infinity;
    for (let i = 0; i < snapshot.ranges.length; ++i) {
      if (snapshot.ranges[i] >= gHangThreshold) {
        numHangs += snapshot.counts[i];
        minBucketLowerBound = Math.min(minBucketLowerBound, snapshot.ranges[i]);
      }
    }
    panel.port.emit("warning", null);
    resolve({numHangs: numHangs, minBucketLowerBound: minBucketLowerBound});
  });
}

function numInputEventResponseLags() {
  return new Promise((resolve) => {
    try {
      var snapshot = Services.telemetry.getHistogramById("INPUT_EVENT_RESPONSE_MS").snapshot();
    } catch (e) { // histogram doesn't exist, the Firefox version is likely older than 46.0a1
      panel.port.emit("warning", "unavailableInputEventResponseLags");
      resolve({numHangs: null, minBucketLowerBound: 0});
    }
    let numHangs = 0;
    let minBucketLowerBound = Infinity;
    for (let i = 0; i < snapshot.ranges.length; ++i) {
      if (snapshot.ranges[i] > gHangThreshold) {
        result += snapshot.counts[i];
        minBucketLowerBound = Math.min(minBucketLowerBound, snapshot.ranges[i]);
      }
    }
    panel.port.emit("warning", null);
    resolve({numHangs: numHangs, minBucketLowerBound: minBucketLowerBound});
  });
}

// Returns an array of the most recent BHR hangs
var previousCountsMap = {}; // this is a mapping from stack traces (as strings) to corresponding histogram counts
var cachedRecentHangs = [];
let lastMostRecentHangsTime = getUptime();
function mostRecentHangs(includeChildHangs = true) {
  if (includeChildHangs && !TelemetrySession.getChildThreadHangs) {
    return new Promise((resolve) => { resolve({numHangs: null, minBucketLowerBound: 0}); });
  }

  let geckoThread = Services.telemetry.threadHangStats.find(thread => thread.name == "Gecko");
  if (!geckoThread || !geckoThread.activity.counts) {
    return new Promise((resolve) => { resolve({numHangs: null, minBucketLowerBound: 0}); });
  }

  return new Promise((resolve) => {
    if (includeChildHangs) {
      getChildThreadHangs().then((hangs) => {
        // accumulate all of the counts in the child processes with the counts in the parent process
        let childHangEntries = [];
        hangs.forEach((threadHangStats) => {
          let childGeckoThread = threadHangStats.find(thread => thread.name == "Gecko_Child");
          if (childGeckoThread && childGeckoThread.activity.counts) {
            childHangEntries = childHangEntries.concat(childGeckoThread.hangs);
          }
        });
        resolve([geckoThread.hangs, childHangEntries]);
      });
    } else { // Just use the parent process stats
      resolve([geckoThread.hangs, []]);
    }
  }).then(hangInfo => {
    [hangEntries, childHangEntries] = hangInfo;
    console.error(childHangEntries)
    let timestamp = (new Date()).getTime(); // note that this timestamp will only be as accurate as the interval at which this function is called
    let uptime = getUptime(); // this value matches the X axis in the timeline for the Gecko Profiler addon

    // diff the current hangs with the previous hangs to figure out what changed in this call, if anything
    // hangs list will only ever grow: https://dxr.mozilla.org/mozilla-central/source/xpcom/threads/BackgroundHangMonitor.cpp#440
    // therefore, we only need to check current stacks against previous stacks - there is no need for a 2 way diff
    // hangs are identified by their stack traces: https://dxr.mozilla.org/mozilla-central/source/toolkit/components/telemetry/Telemetry.cpp#4316
    function diffHangEntry(hangEntry, isChild) {
      var stack = hangEntry.stack.slice(0).reverse().join("\n");
      var ranges = hangEntry.histogram.ranges.concat([Infinity]);
      var counts = hangEntry.histogram.counts;
      var previousCounts = previousCountsMap.hasOwnProperty(stack) ? previousCountsMap[stack] : [];

      // diff this hang histogram with the previous hang histogram
      counts.forEach((count, i) => {
        var previousCount = previousCounts[i] || 0;
        /*
        NOTE: when you access the thread hangs, the ranges are actually the inclusive upper bounds of the buckets rather than the inclusive lower bound like other histograms.
        Basically, when we access the buckets of a TimeHistogram in JS, it has a 0 prepended to the ranges; in C++, the indices behave as all other histograms do.

        For example, bucket 7 actually represents hangs of duration 64ms to 127ms, inclusive. For most other exponential histograms, this would be 128ms to 255ms.

        References:
        * mozilla::Telemetry::CreateJSTimeHistogram - http://mxr.mozilla.org/mozilla-central/source/toolkit/components/telemetry/Telemetry.cpp#2947
        * mozilla::Telemetry::TimeHistogram - http://mxr.mozilla.org/mozilla-central/source/toolkit/components/telemetry/ThreadHangStats.h#25
        */
        while (count > previousCount) { // each additional count here is a new hang with this stack and a duration in this bucket's range
          let lowerBound = ranges[i - 1] + 1;
          if (lowerBound >= gHangThreshold) {
            cachedRecentHangs.push({
              stack: stack, lowerBound: lowerBound, upperBound: ranges[i],
              timestamp: timestamp, uptime: uptime, previousUptime: lastMostRecentHangsTime,
              isChild: isChild,
            });
            if (cachedRecentHangs.length > 10) { // only keep the last 10 items
              cachedRecentHangs.shift();
            }
          }
          count --;
        }
      });

      // the hang entry is not mutated when new instances of this hang come in
      // since we aren't using this entry in the previous hangs anymore, we can just set it in the previous hangs
      previousCountsMap[stack] = counts;
    }
    hangEntries.forEach(entry => { diffHangEntry(entry, false); });
    childHangEntries.forEach(entry => { diffHangEntry(entry, true); });
    lastMostRecentHangsTime = uptime;
    return cachedRecentHangs;
  });
}

var soundPlayerPage = require("sdk/page-worker").Page({
  contentScriptFile: "./play-sound.js",
  contentURL: "./play-sound.html",
});

// returns the number of milliseconds since the process was created, or null if this is not available
let profiler = null;
try {
  profiler = Cc["@mozilla.org/tools/profiler;1"].getService(Ci.nsIProfiler);
} catch(e) {} // fail gracefully; if this fails, we will return null in `getUptime()`
function getUptime() {
  try {
    return profiler.getElapsedTime();
  } catch (e) { // retrieving the pref failed, but we can still fail gracefully and just not show it
    return null;
  }
}

let numHangs = null;
let computedThreshold = 0;
let numHangsObserved = 0;
let prevNumHangs = null;
let baseNumHangs = 0; // the number of hangs at the time the counter was last reset
const BADGE_COLOURS = ["red", "blue", "brown", "black"];
function updateBadge() {
  if (numHangs === null) {
    button.badge = "?"
    button.badgeColor = "yellow";
    prevNumHangs = null;
  } else {
    button.badge = (numHangs - baseNumHangs) - numHangsObserved;
    button.badgeColor = BADGE_COLOURS[button.badge % BADGE_COLOURS.length];

    // tell the panel to play a sound if the number of hangs has been incremented
    if (gPlaySound && prevNumHangs !== null && button.badge > prevNumHangs) {
     soundPlayerPage.port.emit("blip", button.badge - prevNumHangs);
    }
    prevNumHangs = button.badge;
  }
}

function clearCount() {
  baseNumHangs = numHangs;
  numHangsObserved = 0;
  computedThreshold = 0;
  cachedRecentHangs = []; // empty out the list of hangs
  updateBadge();
  panel.port.emit("set-computed-threshold", computedThreshold);
  panel.port.emit("set-hangs", []); // clear the panel's list of hangs
}

const CHECK_FOR_HANG_INTERVAL = 400; // in millis
function update() {
  getHangs().then((result) => {
    let { numHangs: hangCount, minBucketLowerBound: lower } = result; // note: numHangs will be null if the hang counter is not available
    if (lower !== computedThreshold) { // update the computed threshold
      computedThreshold = lower;
      panel.port.emit("set-computed-threshold", computedThreshold);
    }
    if (hangCount !== numHangs) { // new hangs detected
      numHangs = hangCount;
      updateBadge();
      mostRecentHangs().then((recentHangs) => {
        panel.port.emit("set-hangs", recentHangs);
        if (recentHangs.length > 0) {
          button.label = "Most recent hang stack:\n\n" + recentHangs[recentHangs.length - 1].stack;
        } else {
          button.label = "No recent hang stacks.";
        }
        setTimeout(update, CHECK_FOR_HANG_INTERVAL);
      });
    } else {
      setTimeout(update, CHECK_FOR_HANG_INTERVAL);
    }
  });
}
getHangs().then((result) => {
  let { numHangs: hangCount, minBucketLowerBound: lower } = result; // note: numHangs will be null if the hang counter is not available
  [numHangs, computedThreshold] = [hangCount, lower];
  clearCount();
  setTimeout(update, CHECK_FOR_HANG_INTERVAL); // we set the timeouts each time to not back up the queue of child thread hang stats requests when the browser is really slow
});

/* Enable this rAF loop to verify that the hangs reported are roughly equal
 * to the number of hangs observed from script. In Nightly 45, they were.
var prevFrameTime = Cu.now();
gWindow.requestAnimationFrame(function framefn() {
  let currentFrameTime = Cu.now();
  if (currentFrameTime - prevFrameTime > gHangThreshold) {
    numHangsObserved++;
    updateBadge();
  }
  prevFrameTime = currentFrameTime;
  gWindow.requestAnimationFrame(framefn);
});
*/
