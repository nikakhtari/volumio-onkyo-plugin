'use strict';

var net = require('net');
var fs = require('fs');

var DEFAULT_PORT = 60128;

function readConfigValue(config, id, fallback) {
  var page = config && config.page;
  var sections = config && (config.sections || (page && page.sections));

  if (config && config[id] && config[id].value !== undefined && config[id].value !== null) {
    return config[id].value;
  }

  if (!Array.isArray(sections)) {
    return fallback;
  }

  for (var i = 0; i < sections.length; i++) {
    var content = sections[i].content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (var j = 0; j < content.length; j++) {
      if (content[j].id === id && content[j].value !== undefined && content[j].value !== null) {
        return content[j].value;
      }
    }
  }

  return fallback;
}

function readBooleanConfigValue(config, id, fallback) {
  var value = readConfigValue(config, id, fallback);

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return String(value).toLowerCase() !== 'false';
}

function buildEiscpPacket(command, unit) {
  var data = Buffer.from('!' + (unit || '1') + command + '\r', 'ascii');
  var packet = Buffer.alloc(16 + data.length);

  packet.write('ISCP', 0, 4, 'ascii');
  packet.writeUInt32BE(16, 4);
  packet.writeUInt32BE(data.length, 8);
  packet.writeUInt8(1, 12);
  packet.writeUInt8(0, 13);
  packet.writeUInt8(0, 14);
  packet.writeUInt8(0, 15);
  data.copy(packet, 16);

  return packet;
}

function log(message) {
  console.log('[onkyo_avr_manager_shutdown] ' + message);
}

function getSystemJobs() {
  var execSync = require('child_process').execSync;

  try {
    return execSync('systemctl list-jobs --plain --no-legend --no-pager 2>/dev/null', {
      encoding: 'utf8',
      timeout: 1000
    });
  } catch (err) {
    return '';
  }
}

function shouldRunForCurrentShutdown() {
  var jobs = getSystemJobs();

  if (/reboot\.target|kexec\.target/i.test(jobs)) {
    log('Reboot detected; receiver power off skipped');
    return false;
  }

  if (/poweroff\.target|halt\.target/i.test(jobs)) {
    return true;
  }

  log('No poweroff or halt job detected; receiver power off skipped');
  return false;
}

function main() {
  var configPath = process.argv[2] || (__dirname + '/config.json');
  var config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  var host = String(readConfigValue(config, 'receiverHost', '')).trim();
  var port = parseInt(readConfigValue(config, 'receiverPort', DEFAULT_PORT), 10) || DEFAULT_PORT;
  var socket;
  var finished = false;

  if (!readBooleanConfigValue(config, 'powerOffOnVolumioShutdown', true)) {
    log('Power off on Volumio shutdown is disabled');
    process.exit(0);
  }

  if (!host) {
    log('Receiver host is not configured');
    process.exit(0);
  }

  if (!shouldRunForCurrentShutdown()) {
    process.exit(0);
  }

  if (port <= 0 || port > 65535) {
    port = DEFAULT_PORT;
  }

  function finish(code) {
    if (finished) {
      return;
    }

    finished = true;
    if (socket) {
      socket.destroy();
    }
    process.exit(code);
  }

  log('Sending power off to ' + host + ':' + port);
  socket = net.createConnection({ host: host, port: port });
  socket.setTimeout(2000);

  socket.on('connect', function () {
    socket.write(buildEiscpPacket('PWR00'), function () {
      log('TX !1PWR00');
      setTimeout(function () {
        finish(0);
      }, 500);
    });
  });

  socket.on('timeout', function () {
    log('Timed out while powering off receiver');
    finish(0);
  });

  socket.on('error', function (err) {
    log('Could not power off receiver: ' + err.message);
    finish(0);
  });
}

main();
