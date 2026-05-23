'use strict';

var net = require('net');
var dgram = require('dgram');
var fs = require('fs');
var libQ = require('kew');
var io = require('socket.io-client');

var DEFAULT_PORT = 60128;
var DEFAULT_RECONNECT_DELAY_MS = 5000;
var DEFAULT_DISCOVERY_TIMEOUT_MS = 3000;
var DEFAULT_DISCOVERY_BROADCAST = '255.255.255.255';
var MAX_VOLUME = 100;

module.exports = OnkyoAvrManager;

function OnkyoAvrManager(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;

  this.config = null;
  this.configFilePath = null;
  this.socket = null;
  this.volumioSocket = null;
  this.discoverySocket = null;
  this.connected = false;
  this.stopping = false;
  this.discovering = false;
  this.pendingPlaybackAutomation = false;
  this.lastPlaybackStatus = null;
  this.lastVolumioVolume = null;
  this.lastVolumioMute = null;
  this.pendingVolumioVolume = null;
  this.volumeOverrideActive = false;
  this.volumeOverrideSettings = null;
  this.volumeOverrideRefreshTimer = null;
  this.reconnectTimer = null;
  this.discoveryTimer = null;
  this.playbackAutomationTimer = null;
  this.volumeDebounceTimer = null;
  this.rxBuffer = '';

  this.state = {
    power: null,
    volume: null,
    input: null,
    muted: null
  };
}

OnkyoAvrManager.prototype.onStart = function () {
  var defer = libQ.defer();

  this.stopping = false;
  this.loadConfig();

  if (this.isAutoDiscoveryEnabled()) {
    this.discoverReceiverAndConnect(true);
  } else {
    this.connect();
  }

  this.startVolumioStateListener();
  this.initVolumioVolumeOverride();

  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.onStop = function () {
  var defer = libQ.defer();

  this.stopping = true;
  this.clearReconnectTimer();
  this.clearDiscoveryTimer();
  this.clearPlaybackAutomationTimer();
  this.clearVolumeDebounceTimer();
  this.clearVolumeOverrideRefreshTimer();
  this.closeDiscoverySocket();
  this.closeVolumioSocket();

  this.closeReceiverSocket();
  this.connected = false;
  this.logInfo('Stopped Onkyo AVR Manager');
  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.closeReceiverSocket = function () {
  if (this.socket) {
    this.socket.removeAllListeners();
    this.socket.end();
    this.socket.destroy();
    this.socket = null;
  }
};

OnkyoAvrManager.prototype.onVolumioStateChange = function (state) {
  this.handleVolumioStateChange(state);
};

OnkyoAvrManager.prototype.onVolumioPushState = function (state) {
  this.handleVolumioStateChange(state);
};

OnkyoAvrManager.prototype.handleVolumioStateChange = function (state) {
  var status = state && state.status;
  var wasPlaying = this.lastPlaybackStatus === 'play';
  var isPlaying = status === 'play';

  this.handleVolumioVolumeState(state);
  this.lastPlaybackStatus = status;

  if (!this.getBooleanConfigValue('playbackAutomation', true)) {
    return;
  }

  if (isPlaying && !wasPlaying) {
    this.logInfo('Playback started; running AVR playback automation');
    this.runPlaybackAutomation();
  }
};

OnkyoAvrManager.prototype.handleVolumioVolumeState = function (state) {
  var volume;
  var mute;

  if (!state || !this.getBooleanConfigValue('volumioVolumeControlsReceiver', true)) {
    return;
  }

  if (!this.volumeOverrideActive && state.volume !== undefined && state.volume !== null) {
    volume = parseInt(state.volume, 10);

    if (!isNaN(volume)) {
      if (this.lastVolumioVolume !== null && volume !== this.lastVolumioVolume) {
        this.scheduleVolumioVolumeChange(volume);
      }

      this.lastVolumioVolume = volume;
    }
  }

  if (state.mute !== undefined) {
    mute = this.normalizeBooleanState(state.mute);
  } else if (state.muted !== undefined) {
    mute = this.normalizeBooleanState(state.muted);
  }

  if (!this.volumeOverrideActive && mute !== null) {
    if (this.lastVolumioMute !== null && mute !== this.lastVolumioMute) {
      this.logInfo('Volumio mute changed to ' + mute + '; setting AVR mute');
      if (mute) {
        this.muteOn();
      } else {
        this.muteOff();
      }
    }

    this.lastVolumioMute = mute;
  }
};

OnkyoAvrManager.prototype.scheduleVolumioVolumeChange = function (volumioVolume) {
  var self = this;
  var debounceMs = parseInt(this.getConfigValue('volumeDebounceMs', 200), 10);

  if (isNaN(debounceMs) || debounceMs < 0) {
    debounceMs = 200;
  }

  this.pendingVolumioVolume = volumioVolume;
  this.clearVolumeDebounceTimer();

  this.volumeDebounceTimer = setTimeout(function () {
    var receiverVolume = self.mapVolumioVolumeToReceiver(self.pendingVolumioVolume);
    self.volumeDebounceTimer = null;

    self.logInfo('Volumio volume slider settled at ' + self.pendingVolumioVolume + '; setting AVR volume to ' + receiverVolume);
    self.setVolume(receiverVolume);
  }, debounceMs);
};

OnkyoAvrManager.prototype.mapVolumioVolumeToReceiver = function (volumioVolume) {
  var receiverMaxVolume = parseInt(this.getConfigValue('receiverMaxVolume', 80), 10);
  var clampedVolumioVolume = Math.max(0, Math.min(100, parseInt(volumioVolume, 10) || 0));

  if (isNaN(receiverMaxVolume) || receiverMaxVolume <= 0) {
    receiverMaxVolume = 80;
  }

  receiverMaxVolume = Math.min(MAX_VOLUME, receiverMaxVolume);

  return Math.round((clampedVolumioVolume / 100) * receiverMaxVolume);
};

OnkyoAvrManager.prototype.mapReceiverVolumeToVolumio = function (receiverVolume) {
  var receiverMaxVolume = parseInt(this.getConfigValue('receiverMaxVolume', 80), 10);
  var clampedReceiverVolume = Math.max(0, Math.min(MAX_VOLUME, parseInt(receiverVolume, 10) || 0));

  if (isNaN(receiverMaxVolume) || receiverMaxVolume <= 0) {
    receiverMaxVolume = 80;
  }

  receiverMaxVolume = Math.min(MAX_VOLUME, receiverMaxVolume);

  return Math.max(0, Math.min(100, Math.round((clampedReceiverVolume / receiverMaxVolume) * 100)));
};

OnkyoAvrManager.prototype.getCurrentVolumioVolume = function () {
  if (this.state.volume !== null && this.state.volume !== undefined) {
    return this.mapReceiverVolumeToVolumio(this.state.volume);
  }

  if (this.lastVolumioVolume !== null && this.lastVolumioVolume !== undefined) {
    return Math.max(0, Math.min(100, parseInt(this.lastVolumioVolume, 10) || 0));
  }

  return 0;
};

OnkyoAvrManager.prototype.buildVolumioVolumeState = function (volume, mute) {
  return {
    vol: Math.max(0, Math.min(100, parseInt(volume, 10) || 0)),
    mute: !!mute,
    disableVolumeControl: false
  };
};

OnkyoAvrManager.prototype.pushVolumioVolumeState = function () {
  var volumeState;

  if (!this.volumeOverrideActive || !this.commandRouter || typeof this.commandRouter.volumioupdatevolume !== 'function') {
    return;
  }

  volumeState = this.buildVolumioVolumeState(this.getCurrentVolumioVolume(), this.state.muted === true);
  this.lastVolumioVolume = volumeState.vol;
  this.lastVolumioMute = volumeState.mute;
  this.commandRouter.volumioupdatevolume(volumeState);
};

OnkyoAvrManager.prototype.initVolumioVolumeOverride = function () {
  var settings;
  var overrideEnabled = this.getBooleanConfigValue('volumioVolumeControlsReceiver', true);

  if (!overrideEnabled) {
    if (this.volumeOverrideActive) {
      this.logInfo('Volumio volume override was already registered; restart Volumio to restore the previous mixer');
    }
    return false;
  }

  if (!this.commandRouter || typeof this.commandRouter.volumioUpdateVolumeSettings !== 'function') {
    this.volumeOverrideActive = false;
    this.logInfo('Volumio volume override API is not available; using pushState listener fallback');
    return false;
  }

  settings = {
    device: '1',
    name: 'Onkyo AVR Manager',
    mixer: 'SoftMaster',
    maxvolume: 100,
    volumecurve: 'linear',
    volumesteps: 1,
    mixertype: 'Software',
    volumeOverride: true,
    pluginType: 'system_controller',
    pluginName: 'onkyo_avr_manager'
  };

  this.volumeOverrideSettings = settings;
  try {
    this.commandRouter.volumioUpdateVolumeSettings(settings);
  } catch (err) {
    this.volumeOverrideActive = false;
    this.logError('Failed to register Volumio volume override: ' + err.message);
    return false;
  }

  this.volumeOverrideActive = true;
  this.pushVolumioVolumeState();
  this.logInfo('Registered Onkyo AVR as Volumio volume override');

  return true;
};

OnkyoAvrManager.prototype.scheduleVolumeOverrideRefresh = function () {
  var self = this;

  if (!this.volumeOverrideActive) {
    return;
  }

  this.clearVolumeOverrideRefreshTimer();
  this.volumeOverrideRefreshTimer = setTimeout(function () {
    self.volumeOverrideRefreshTimer = null;
    self.initVolumioVolumeOverride();
  }, 500);
};

OnkyoAvrManager.prototype.normalizeBooleanState = function (value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (value === undefined || value === null || value === '') {
    return null;
  }

  return String(value).toLowerCase() === 'true' || String(value) === '1';
};

OnkyoAvrManager.prototype.startVolumioStateListener = function () {
  var self = this;

  this.closeVolumioSocket();
  this.logInfo('Starting local Volumio playback state listener');

  this.volumioSocket = io.connect('http://localhost:3000', {
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000
  });

  this.volumioSocket.on('connect', function () {
    self.logInfo('Connected to local Volumio playback state listener');
    self.volumioSocket.emit('getState');
  });

  this.volumioSocket.on('pushState', function (state) {
    self.handleVolumioStateChange(state);
  });

  this.volumioSocket.on('disconnect', function () {
    self.logInfo('Disconnected from local Volumio playback state listener');
  });

  this.volumioSocket.on('connect_error', function (err) {
    self.logError('Volumio playback state listener connection error: ' + err.message);
  });
};

OnkyoAvrManager.prototype.closeVolumioSocket = function () {
  if (this.volumioSocket) {
    this.volumioSocket.removeAllListeners();
    this.volumioSocket.close();
    this.volumioSocket = null;
  }
};

OnkyoAvrManager.prototype.loadConfig = function () {
  var configSource;

  if (this.configManager && typeof this.configManager.getConfigurationFile === 'function') {
    configSource = this.configManager.getConfigurationFile(this.context, 'config.json');

    if (typeof configSource === 'string') {
      this.configFilePath = configSource;
      this.config = JSON.parse(fs.readFileSync(configSource, 'utf8'));
      return;
    }

    this.config = configSource;
  } else {
    this.config = require('./config.json');
  }
};

OnkyoAvrManager.prototype.getUIConfig = function () {
  var defer = libQ.defer();
  var self = this;
  var langCode = 'en';

  if (!this.config) {
    this.loadConfig();
  }

  if (this.commandRouter && this.commandRouter.sharedVars && typeof this.commandRouter.sharedVars.get === 'function') {
    langCode = this.commandRouter.sharedVars.get('language_code') || 'en';
  }

  if (this.commandRouter && typeof this.commandRouter.i18nJson === 'function') {
    this.commandRouter.i18nJson(
      __dirname + '/i18n/strings_' + langCode + '.json',
      __dirname + '/i18n/strings_en.json',
      __dirname + '/UIConfig.json'
    ).then(function (uiConfig) {
      self.applyConfigValuesToUIConfig(uiConfig);
      defer.resolve(uiConfig);
    }).fail(function (err) {
      self.logError('Failed to load UI config through i18nJson: ' + err);
      defer.resolve(self.loadRawUIConfig());
    });

    return defer.promise;
  }

  defer.resolve(this.loadRawUIConfig());
  return defer.promise;
};

OnkyoAvrManager.prototype.loadRawUIConfig = function () {
  var uiConfig = JSON.parse(fs.readFileSync(__dirname + '/UIConfig.json', 'utf8'));
  this.applyConfigValuesToUIConfig(uiConfig);

  return uiConfig;
};

OnkyoAvrManager.prototype.applyConfigValuesToUIConfig = function (uiConfig) {
  var sections = uiConfig && (uiConfig.sections || (uiConfig.page && uiConfig.page.sections));

  if (!Array.isArray(sections)) {
    return;
  }

  for (var i = 0; i < sections.length; i++) {
    var content = sections[i].content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (var j = 0; j < content.length; j++) {
      content[j].value = this.getConfigValue(content[j].id, content[j].value);
    }
  }
};

OnkyoAvrManager.prototype.getConfigValue = function (id, fallback) {
  var page = this.config && this.config.page;
  var sections = this.config && (this.config.sections || (page && page.sections));

  if (this.config && this.config[id] && this.config[id].value !== undefined && this.config[id].value !== null) {
    return this.config[id].value;
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
};

OnkyoAvrManager.prototype.getReceiverHost = function () {
  return String(this.getConfigValue('receiverHost', '')).trim();
};

OnkyoAvrManager.prototype.getReceiverPort = function () {
  return parseInt(this.getConfigValue('receiverPort', DEFAULT_PORT), 10) || DEFAULT_PORT;
};

OnkyoAvrManager.prototype.getReconnectDelayMs = function () {
  return parseInt(this.getConfigValue('reconnectDelayMs', DEFAULT_RECONNECT_DELAY_MS), 10) || DEFAULT_RECONNECT_DELAY_MS;
};

OnkyoAvrManager.prototype.getDiscoveryTimeoutMs = function () {
  return parseInt(this.getConfigValue('discoveryTimeoutMs', DEFAULT_DISCOVERY_TIMEOUT_MS), 10) || DEFAULT_DISCOVERY_TIMEOUT_MS;
};

OnkyoAvrManager.prototype.getDiscoveryBroadcastAddress = function () {
  return String(this.getConfigValue('discoveryBroadcastAddress', DEFAULT_DISCOVERY_BROADCAST)).trim() || DEFAULT_DISCOVERY_BROADCAST;
};

OnkyoAvrManager.prototype.isAutoDiscoveryEnabled = function () {
  return this.getBooleanConfigValue('autoDiscovery', true);
};

OnkyoAvrManager.prototype.getBooleanConfigValue = function (id, fallback) {
  var value = this.getConfigValue(id, fallback);

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
};

OnkyoAvrManager.prototype.connect = function () {
  var self = this;
  var host = this.getReceiverHost();
  var port = this.getReceiverPort();

  this.clearReconnectTimer();

  if (this.stopping) {
    return;
  }

  if (!host) {
    this.logError('Receiver host is not configured');
    if (this.isAutoDiscoveryEnabled()) {
      this.discoverReceiverAndConnect();
      return;
    }
    this.scheduleReconnect();
    return;
  }

  if (this.socket) {
    this.socket.removeAllListeners();
    this.socket.destroy();
    this.socket = null;
  }

  this.connected = false;
  this.rxBuffer = '';
  this.logInfo('Connecting to Onkyo AVR at ' + host + ':' + port);

  this.socket = net.createConnection({ host: host, port: port });
  this.socket.setKeepAlive(true, 30000);

  this.socket.on('connect', function () {
    self.connected = true;
    self.logInfo('Connected to Onkyo AVR at ' + host + ':' + port);
    self.pushToast('success', 'Onkyo AVR Connected', host + ':' + port);
    self.queryPower();
    self.queryVolume();
    self.queryInput();

    if (self.pendingPlaybackAutomation) {
      self.pendingPlaybackAutomation = false;
      self.runPlaybackAutomation();
    }
  });

  this.socket.on('data', function (data) {
    self.handleData(data);
  });

  this.socket.on('close', function () {
    self.connected = false;
    self.logInfo('Onkyo AVR socket closed');
    self.socket = null;
    self.scheduleReconnect();
  });

  this.socket.on('error', function (err) {
    self.connected = false;
    self.logError('Onkyo AVR socket error: ' + err.message);
    if (self.socket) {
      self.socket.destroy();
    }
    if (self.isAutoDiscoveryEnabled()) {
      self.discoverReceiverAndConnect();
    } else {
      self.scheduleReconnect();
    }
  });
};

OnkyoAvrManager.prototype.scheduleReconnect = function () {
  var self = this;

  if (this.stopping || this.reconnectTimer) {
    return;
  }

  this.reconnectTimer = setTimeout(function () {
    self.reconnectTimer = null;
    self.connect();
  }, this.getReconnectDelayMs());

  this.logInfo('Scheduled Onkyo AVR reconnect in ' + this.getReconnectDelayMs() + ' ms');
};

OnkyoAvrManager.prototype.discoverReceiverAndConnect = function (fallbackToConfiguredHost) {
  var self = this;

  this.discoverReceiver().then(function (result) {
    if (result && result.address) {
      self.handleDiscoveredReceiver(result);
      self.connect();
      return;
    }

    if (fallbackToConfiguredHost && self.getReceiverHost()) {
      self.logInfo('Discovery did not find a receiver; trying configured host ' + self.getReceiverHost());
      self.connect();
      return;
    }

    self.scheduleReconnect();
  }).fail(function (err) {
    self.logError('Onkyo AVR discovery failed: ' + err);
    if (fallbackToConfiguredHost && self.getReceiverHost()) {
      self.connect();
      return;
    }

    self.scheduleReconnect();
  });
};

OnkyoAvrManager.prototype.discoverReceiver = function () {
  var defer = libQ.defer();
  var self = this;
  var port = this.getReceiverPort();
  var broadcastAddress = this.getDiscoveryBroadcastAddress();
  var timeoutMs = this.getDiscoveryTimeoutMs();
  var packet = this.buildEiscpPacket('ECNQSTN', 'x');

  if (this.discovering) {
    defer.resolve(null);
    return defer.promise;
  }

  this.discovering = true;
  this.closeDiscoverySocket();
  this.logInfo('Discovering Onkyo AVR via UDP broadcast ' + broadcastAddress + ':' + port);

  this.discoverySocket = dgram.createSocket('udp4');

  this.discoverySocket.on('message', function (message, rinfo) {
    var response = message.toString('ascii');
    var model = self.extractDiscoveryModel(response);

    self.logInfo('Discovery RX from ' + rinfo.address + ':' + rinfo.port + ' ' + response.replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
    self.discovering = false;
    self.clearDiscoveryTimer();
    self.closeDiscoverySocket();

    defer.resolve({
      address: rinfo.address,
      port: port,
      model: model
    });
  });

  this.discoverySocket.on('error', function (err) {
    self.logError('Discovery socket error: ' + err.message);
    self.discovering = false;
    self.clearDiscoveryTimer();
    self.closeDiscoverySocket();
    defer.reject(err);
  });

  this.discoverySocket.bind(function () {
    if (!self.discoverySocket) {
      return;
    }

    self.discoverySocket.setBroadcast(true);
    self.logInfo('Discovery TX !xECNQSTN');
    self.discoverySocket.send(packet, 0, packet.length, port, broadcastAddress, function (err) {
      if (err) {
        self.logError('Discovery send failed: ' + err.message);
        self.discovering = false;
        self.clearDiscoveryTimer();
        self.closeDiscoverySocket();
        defer.reject(err);
      }
    });
  });

  this.discoveryTimer = setTimeout(function () {
    self.logError('Onkyo AVR discovery timed out after ' + timeoutMs + ' ms');
    self.discovering = false;
    self.closeDiscoverySocket();
    defer.resolve(null);
  }, timeoutMs);

  return defer.promise;
};

OnkyoAvrManager.prototype.extractDiscoveryModel = function (response) {
  var match = /!1ECN([^\r\n\x1a]+)/.exec(response);

  if (!match) {
    return null;
  }

  return match[1];
};

OnkyoAvrManager.prototype.handleDiscoveredReceiver = function (result) {
  var currentHost = this.getReceiverHost();
  var description = result.model ? result.model + ' at ' + result.address : result.address;

  if (currentHost !== result.address) {
    this.setConfigValue('receiverHost', result.address);
    this.saveConfig();
    this.logInfo('Discovered Onkyo AVR IP changed from ' + currentHost + ' to ' + result.address);
    this.pushToast('success', 'Onkyo AVR Discovered', description);
    return;
  }

  this.logInfo('Discovered Onkyo AVR at existing IP ' + result.address);
};

OnkyoAvrManager.prototype.closeDiscoverySocket = function () {
  if (this.discoverySocket) {
    this.discoverySocket.removeAllListeners();
    try {
      this.discoverySocket.close();
    } catch (err) {
      this.logError('Discovery socket close failed: ' + err.message);
    }
    this.discoverySocket = null;
  }
};

OnkyoAvrManager.prototype.clearDiscoveryTimer = function () {
  if (this.discoveryTimer) {
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
  }
};

OnkyoAvrManager.prototype.clearPlaybackAutomationTimer = function () {
  if (this.playbackAutomationTimer) {
    clearTimeout(this.playbackAutomationTimer);
    this.playbackAutomationTimer = null;
  }
};

OnkyoAvrManager.prototype.clearVolumeDebounceTimer = function () {
  if (this.volumeDebounceTimer) {
    clearTimeout(this.volumeDebounceTimer);
    this.volumeDebounceTimer = null;
  }
};

OnkyoAvrManager.prototype.clearVolumeOverrideRefreshTimer = function () {
  if (this.volumeOverrideRefreshTimer) {
    clearTimeout(this.volumeOverrideRefreshTimer);
    this.volumeOverrideRefreshTimer = null;
  }
};

OnkyoAvrManager.prototype.clearReconnectTimer = function () {
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
};

OnkyoAvrManager.prototype.buildEiscpPacket = function (command, unit) {
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
};

OnkyoAvrManager.prototype.sendCommand = function (command) {
  if (!this.socket || !this.connected) {
    this.logError('Cannot send eISCP command while disconnected: !1' + command);
    this.scheduleReconnect();
    return false;
  }

  this.logInfo('TX !1' + command);
  this.socket.write(this.buildEiscpPacket(command));
  return true;
};

OnkyoAvrManager.prototype.handleData = function (data) {
  this.logInfo('RX ' + data.toString('ascii').replace(/\r/g, '\\r').replace(/\n/g, '\\n'));

  this.rxBuffer += data.toString('ascii');
  this.parseRxBuffer();
};

OnkyoAvrManager.prototype.parseRxBuffer = function () {
  var messageMatch;
  var lastConsumedIndex = 0;
  var messageRegex = /!1([A-Z0-9]{3})([0-9A-Fa-f]{2})/g;

  while ((messageMatch = messageRegex.exec(this.rxBuffer)) !== null) {
    this.handleFeedback(messageMatch[1], messageMatch[2].toUpperCase());
    lastConsumedIndex = messageRegex.lastIndex;
  }

  if (lastConsumedIndex > 0) {
    this.rxBuffer = this.rxBuffer.slice(lastConsumedIndex);
  }

  if (this.rxBuffer.length > 1024) {
    this.rxBuffer = this.rxBuffer.slice(-256);
  }
};

OnkyoAvrManager.prototype.handleFeedback = function (type, value) {
  if (type === 'PWR') {
    this.state.power = value;
    this.logInfo('RX parsed power: ' + value);
    return;
  }

  if (type === 'MVL') {
    this.state.volume = parseInt(value, 16);
    this.logInfo('RX parsed volume: ' + this.state.volume + ' (0x' + value + ')');
    this.pushVolumioVolumeState();
    return;
  }

  if (type === 'AMT') {
    this.state.muted = value === '01';
    this.logInfo('RX parsed mute: ' + this.state.muted + ' (0x' + value + ')');
    this.pushVolumioVolumeState();
    return;
  }

  if (type === 'SLI') {
    this.state.input = value;
    this.logInfo('RX parsed input: ' + value);
    return;
  }
};

OnkyoAvrManager.prototype.powerOn = function () {
  return this.sendCommand('PWR01');
};

OnkyoAvrManager.prototype.powerOff = function () {
  return this.sendCommand('PWR00');
};

OnkyoAvrManager.prototype.queryPower = function () {
  return this.sendCommand('PWRQSTN');
};

OnkyoAvrManager.prototype.queryVolume = function () {
  return this.sendCommand('MVLQSTN');
};

OnkyoAvrManager.prototype.queryInput = function () {
  return this.sendCommand('SLIQSTN');
};

OnkyoAvrManager.prototype.selectConfiguredInput = function () {
  var input = String(this.getConfigValue('hdmiInput', '13')).trim().toUpperCase();
  return this.selectInput(input);
};

OnkyoAvrManager.prototype.selectInput = function (input) {
  var value = String(input || '').trim().toUpperCase();

  if (!/^[0-9A-F]{2}$/.test(value)) {
    this.logError('Invalid Onkyo SLI input code: ' + input);
    return false;
  }

  return this.sendCommand('SLI' + value);
};

OnkyoAvrManager.prototype.setVolume = function (volume) {
  var numericVolume = parseInt(volume, 10);

  if (isNaN(numericVolume)) {
    this.logError('Invalid volume value: ' + volume);
    return false;
  }

  numericVolume = Math.max(0, Math.min(MAX_VOLUME, numericVolume));
  return this.sendCommand('MVL' + this.toHexByte(numericVolume));
};

OnkyoAvrManager.prototype.volumeUp = function () {
  return this.sendCommand('MVLUP');
};

OnkyoAvrManager.prototype.volumeDown = function () {
  return this.sendCommand('MVLDOWN');
};

OnkyoAvrManager.prototype.runPlaybackAutomation = function () {
  var self = this;
  var delayMs = parseInt(this.getConfigValue('playbackPowerDelayMs', 1500), 10) || 1500;

  this.clearPlaybackAutomationTimer();

  if (!this.connected) {
    this.logInfo('AVR is disconnected; connecting before playback automation');
    this.pendingPlaybackAutomation = true;

    if (this.isAutoDiscoveryEnabled()) {
      this.discoverReceiverAndConnect(true);
    } else {
      this.connect();
    }

    return;
  }

  if (this.getBooleanConfigValue('powerOnPlayback', true)) {
    this.powerOn();
  }

  this.playbackAutomationTimer = setTimeout(function () {
    self.playbackAutomationTimer = null;

    if (!self.connected) {
      self.pendingPlaybackAutomation = true;
      self.logError('AVR disconnected before playback automation completed');
      return;
    }

    if (self.getBooleanConfigValue('selectInputOnPlayback', true)) {
      self.selectConfiguredInput();
      setTimeout(function () {
        self.queryInput();
      }, 500);
    }

    if (self.getBooleanConfigValue('unmuteOnPlayback', true)) {
      self.muteOff();
    }

    if (self.getBooleanConfigValue('setDefaultVolumeOnPlayback', false)) {
      self.setVolume(self.getConfigValue('defaultVolume', 35));
    }
  }, delayMs);
};

OnkyoAvrManager.prototype.muteOn = function () {
  this.state.muted = true;
  this.pushVolumioVolumeState();
  return this.sendCommand('AMT01');
};

OnkyoAvrManager.prototype.muteOff = function () {
  this.state.muted = false;
  this.pushVolumioVolumeState();
  return this.sendCommand('AMT00');
};

OnkyoAvrManager.prototype.updateVolumeSettings = function (settings) {
  var defer = libQ.defer();

  this.volumeOverrideSettings = settings || this.volumeOverrideSettings;
  defer.resolve(this.buildVolumioVolumeState(this.getCurrentVolumioVolume(), this.state.muted === true));
  return defer.promise;
};

OnkyoAvrManager.prototype.alsavolume = function (volumeCommand) {
  var defer = libQ.defer();
  var currentVolume = this.getCurrentVolumioVolume();
  var volumioVolume = currentVolume;
  var receiverVolume;

  switch (volumeCommand) {
    case 'mute':
      this.muteOn();
      this.scheduleVolumeOverrideRefresh();
      defer.resolve(this.buildVolumioVolumeState(currentVolume, true));
      return defer.promise;
    case 'unmute':
      this.muteOff();
      this.scheduleVolumeOverrideRefresh();
      defer.resolve(this.buildVolumioVolumeState(currentVolume, false));
      return defer.promise;
    case 'toggle':
      if (this.state.muted) {
        this.muteOff();
        this.scheduleVolumeOverrideRefresh();
        defer.resolve(this.buildVolumioVolumeState(currentVolume, false));
      } else {
        this.muteOn();
        this.scheduleVolumeOverrideRefresh();
        defer.resolve(this.buildVolumioVolumeState(currentVolume, true));
      }
      return defer.promise;
    case '+':
      volumioVolume = Math.min(100, currentVolume + 1);
      break;
    case '-':
      volumioVolume = Math.max(0, currentVolume - 1);
      break;
    default:
      volumioVolume = parseInt(volumeCommand, 10);
      if (isNaN(volumioVolume)) {
        this.logError('Invalid Volumio volume command: ' + volumeCommand);
        defer.resolve(this.buildVolumioVolumeState(currentVolume, this.state.muted === true));
        return defer.promise;
      }
  }

  volumioVolume = Math.max(0, Math.min(100, volumioVolume));
  receiverVolume = this.mapVolumioVolumeToReceiver(volumioVolume);
  this.lastVolumioVolume = volumioVolume;
  this.lastVolumioMute = false;
  this.state.volume = receiverVolume;
  this.state.muted = false;

  this.logInfo('Volumio volume override set to ' + volumioVolume + '; setting AVR volume to ' + receiverVolume);
  this.setVolume(receiverVolume);
  this.scheduleVolumeOverrideRefresh();
  defer.resolve(this.buildVolumioVolumeState(volumioVolume, false));

  return defer.promise;
};

OnkyoAvrManager.prototype.retrievevolume = function () {
  var defer = libQ.defer();

  defer.resolve(this.buildVolumioVolumeState(this.getCurrentVolumioVolume(), this.state.muted === true));
  return defer.promise;
};

OnkyoAvrManager.prototype.getReceiverState = function () {
  var defer = libQ.defer();

  defer.resolve({
    connected: this.connected,
    discovering: this.discovering,
    host: this.getReceiverHost(),
    port: this.getReceiverPort(),
    power: this.state.power,
    volume: this.state.volume,
    input: this.state.input,
    muted: this.state.muted,
    receiverMaxVolume: parseInt(this.getConfigValue('receiverMaxVolume', 80), 10) || 80
  });

  return defer.promise;
};

OnkyoAvrManager.prototype.refreshReceiverState = function () {
  var defer = libQ.defer();

  this.queryPower();
  this.queryVolume();
  this.queryInput();

  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.setReceiverVolume = function (data) {
  var defer = libQ.defer();
  var volume = data && data.volume !== undefined ? data.volume : data;
  var receiverVolume = this.mapVolumioVolumeToReceiver(volume);

  this.setVolume(receiverVolume);
  this.pushToast('success', 'Onkyo AVR Volume', String(receiverVolume));

  defer.resolve(receiverVolume);
  return defer.promise;
};

OnkyoAvrManager.prototype.receiverVolumeUp = function () {
  var defer = libQ.defer();

  this.volumeUp();
  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.receiverVolumeDown = function () {
  var defer = libQ.defer();

  this.volumeDown();
  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.receiverMuteOn = function () {
  var defer = libQ.defer();

  this.muteOn();
  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.receiverMuteOff = function () {
  var defer = libQ.defer();

  this.muteOff();
  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.receiverMuteToggle = function () {
  var defer = libQ.defer();

  if (this.state.muted) {
    this.muteOff();
  } else {
    this.muteOn();
  }

  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.saveSettings = function (data) {
  var defer = libQ.defer();
  var values = data || {};

  this.setConfigValue('receiverHost', values.receiverHost);
  this.setConfigValue('receiverPort', values.receiverPort);
  this.setConfigValue('autoDiscovery', values.autoDiscovery);
  this.setConfigValue('discoveryBroadcastAddress', values.discoveryBroadcastAddress);
  this.setConfigValue('discoveryTimeoutMs', values.discoveryTimeoutMs);
  this.setConfigValue('hdmiInput', values.hdmiInput);
  this.setConfigValue('playbackAutomation', values.playbackAutomation);
  this.setConfigValue('powerOnPlayback', values.powerOnPlayback);
  this.setConfigValue('selectInputOnPlayback', values.selectInputOnPlayback);
  this.setConfigValue('unmuteOnPlayback', values.unmuteOnPlayback);
  this.setConfigValue('setDefaultVolumeOnPlayback', values.setDefaultVolumeOnPlayback);
  this.setConfigValue('volumioVolumeControlsReceiver', values.volumioVolumeControlsReceiver);
  this.setConfigValue('receiverMaxVolume', values.receiverMaxVolume);
  this.setConfigValue('volumeDebounceMs', values.volumeDebounceMs);
  this.setConfigValue('playbackPowerDelayMs', values.playbackPowerDelayMs);
  this.setConfigValue('defaultVolume', values.defaultVolume);
  this.setConfigValue('reconnectDelayMs', values.reconnectDelayMs);

  this.saveConfig();
  this.initVolumioVolumeOverride();

  this.logInfo('Saved Onkyo AVR Manager settings');
  this.pushToast('success', 'Onkyo AVR Manager', 'Settings saved. Reconnecting to receiver.');

  if (this.isAutoDiscoveryEnabled()) {
    this.discoverReceiverAndConnect(true);
  } else {
    this.connect();
  }

  defer.resolve();
  return defer.promise;
};

OnkyoAvrManager.prototype.saveConfig = function () {
  if (this.configManager && typeof this.configManager.saveConfigFile === 'function') {
    this.configManager.saveConfigFile(this.context, 'config.json', this.config);
  } else if (this.configFilePath) {
    fs.writeFileSync(this.configFilePath, JSON.stringify(this.config, null, 2));
  }
};

OnkyoAvrManager.prototype.setConfigValue = function (id, value) {
  var page = this.config && this.config.page;
  var sections = this.config && (this.config.sections || (page && page.sections));

  if (value === undefined) {
    return;
  }

  if (this.config && this.config[id]) {
    this.config[id].value = value;
    return;
  }

  if (!Array.isArray(sections)) {
    if (!this.config) {
      this.config = {};
    }

    this.config[id] = {
      type: typeof value === 'number' ? 'number' : 'string',
      value: value
    };
    return;
  }

  for (var i = 0; i < sections.length; i++) {
    var content = sections[i].content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (var j = 0; j < content.length; j++) {
      if (content[j].id === id) {
        content[j].value = value;
        return;
      }
    }
  }
};

OnkyoAvrManager.prototype.toHexByte = function (value) {
  var hex = value.toString(16).toUpperCase();
  return hex.length === 1 ? '0' + hex : hex;
};

OnkyoAvrManager.prototype.logInfo = function (message) {
  if (this.logger && typeof this.logger.info === 'function') {
    this.logger.info('[onkyo_avr_manager] ' + message);
  }
};

OnkyoAvrManager.prototype.logError = function (message) {
  if (this.logger && typeof this.logger.error === 'function') {
    this.logger.error('[onkyo_avr_manager] ' + message);
  } else {
    this.logInfo('ERROR: ' + message);
  }
};

OnkyoAvrManager.prototype.pushToast = function (type, title, message) {
  if (this.commandRouter && typeof this.commandRouter.pushToastMessage === 'function') {
    this.commandRouter.pushToastMessage(type, title, message);
  }
};
