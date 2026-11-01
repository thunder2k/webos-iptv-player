// Runs on the TV under its own Node.js (0.12 on webOS 4, so ES5 only) and
// writes Linux input events into the TV's input devices. tv-input.mjs sends
// this source with `node -e`, followed by steps:
//   k:<code>      press and release a key on the IR remote
//   c:            press and release the left button on ClickableMouse
//   m:<dx>,<dy>   relative pointer move on ClickableMouse
//   w:<n>[@x,y]   wheel notches (positive scrolls down) on the Magic Remote
//   s:<ms>        sleep
// Devices are found by name because event numbers vary between models. A wheel
// from the Magic Remote fires at that remote's own absolute position
// (ABS_X/ABS_Y, 0-1920 x 0-1080) and otherwise recenters the cursor; ABS
// alone does not move the cursor.
'use strict';

var fs = require('fs');

var EV_SYN = 0;
var EV_KEY = 1;
var EV_REL = 2;
var EV_ABS = 3;
var REL_X = 0;
var REL_Y = 1;
var REL_WHEEL = 8;
var ABS_X = 0;
var ABS_Y = 1;
var BTN_LEFT = 272;
var DEVICES = { k: 'LGE RCU', c: 'ClickableMouse', m: 'ClickableMouse', w: 'LGE M-RCU' };

function parseDevices(text) {
  var names = {};
  text.split('\n\n').forEach(function (block) {
    var name = null;
    var handler = null;
    block.split('\n').forEach(function (line) {
      if (line.indexOf('N: Name=') === 0) name = line.slice(9, -1);
      if (line.indexOf('H: Handlers=') === 0) {
        handler = line.slice(12).split(' ').filter(function (h) {
          return h.indexOf('event') === 0;
        })[0] || null;
      }
    });
    if (name && handler && !names[name]) names[name] = '/dev/input/' + handler;
  });
  return names;
}

function findDevice(names, prefix) {
  var matches = Object.keys(names).filter(function (name) {
    return name.indexOf(prefix) === 0;
  }).sort();
  if (!matches.length) throw new Error('no input device named ' + prefix);
  return names[matches[0]];
}

// struct input_event: a timeval of two longs, then u16 type, u16 code, s32 value.
function encodeEvent(type, code, value, nowMs, longBytes) {
  var size = longBytes * 2 + 8;
  // Node.js 0.12 has no Buffer.alloc; newer Node warns on new Buffer().
  var NativeBuffer = Buffer;
  var buffer = NativeBuffer.alloc ? NativeBuffer.alloc(size) : new NativeBuffer(size);
  buffer.fill(0);
  var seconds = Math.floor(nowMs / 1000);
  var micros = Math.floor((nowMs % 1000) * 1000);
  buffer.writeUInt32LE(seconds >>> 0, 0);
  buffer.writeUInt32LE(micros, longBytes);
  buffer.writeUInt16LE(type, longBytes * 2);
  buffer.writeUInt16LE(code, longBytes * 2 + 2);
  buffer.writeInt32LE(value, longBytes * 2 + 4);
  return buffer;
}

// Each step becomes a list of [device kind, type, code, value] events and
// sleeps; a SYN_REPORT closes every frame.
function planEvents(steps) {
  var plan = [];
  function frame(kind, events) {
    events.forEach(function (event) { plan.push([kind].concat(event)); });
    plan.push([kind, EV_SYN, 0, 0]);
  }
  function press(kind, code) {
    frame(kind, [[EV_KEY, code, 1]]);
    plan.push(50);
    frame(kind, [[EV_KEY, code, 0]]);
  }
  steps.forEach(function (step) {
    var kind = step.charAt(0);
    var arg = step.slice(2);
    if (step.charAt(1) !== ':') throw new Error('bad step ' + step);
    if (kind === 'k') press('k', Number(arg));
    else if (kind === 'c') press('c', BTN_LEFT);
    else if (kind === 'm') {
      var delta = arg.split(',').map(Number);
      var rel = [];
      if (delta[0]) rel.push([EV_REL, REL_X, delta[0]]);
      if (delta[1]) rel.push([EV_REL, REL_Y, delta[1]]);
      frame('m', rel);
      // Steps closer than 30 ms accelerate past the calibrated gain.
      plan.push(60);
    } else if (kind === 'w') {
      var parts = arg.split('@');
      if (parts[1]) {
        var at = parts[1].split(',').map(Number);
        // evdev drops an unchanged ABS value, so step off the target first.
        frame('w', [[EV_ABS, ABS_X, at[0] ? at[0] - 1 : 1], [EV_ABS, ABS_Y, at[1] ? at[1] - 1 : 1]]);
        frame('w', [[EV_ABS, ABS_X, at[0]], [EV_ABS, ABS_Y, at[1]]]);
      }
      frame('w', [[EV_REL, REL_WHEEL, -Number(parts[0])]]);
    } else if (kind === 's') plan.push(Number(arg));
    else throw new Error('bad step ' + step);
  });
  return plan;
}

function fail(e) {
  process.stderr.write('tv-input: ' + e.message + '\n');
  process.exit(1);
}

function run(steps, io, onError) {
  io = io || fs;
  onError = onError || fail;
  var names = parseDevices(io.readFileSync('/proc/bus/input/devices', 'utf8'));
  var longBytes = /64/.test(process.arch) ? 8 : 4;
  var fds = {};
  var plan = planEvents(steps);
  var i = 0;
  function closeAll() {
    Object.keys(fds).forEach(function (kind) { io.closeSync(fds[kind]); });
    fds = {};
  }
  function next() {
    // Steps after a sleep run from a timer, outside the caller's try/catch.
    try {
      while (i < plan.length) {
        var item = plan[i++];
        if (typeof item === 'number') {
          setTimeout(next, item);
          return;
        }
        var kind = item[0];
        if (!fds[kind]) fds[kind] = io.openSync(findDevice(names, DEVICES[kind]), 'w');
        var buffer = encodeEvent(item[1], item[2], item[3], Date.now(), longBytes);
        io.writeSync(fds[kind], buffer, 0, buffer.length);
      }
    } catch (e) {
      closeAll();
      onError(e);
      return;
    }
    closeAll();
  }
  next();
}

module.exports = {
  parseDevices: parseDevices, findDevice: findDevice, encodeEvent: encodeEvent, planEvents: planEvents, run: run,
};

if (!module.parent) {
  try {
    run(process.argv.slice(1).filter(function (arg) { return /^[a-z]:/.test(arg); }));
  } catch (e) {
    fail(e);
  }
}
