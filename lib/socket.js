'use strict';

const Assert = require('assert');
const Events = require('events');
const URL = require('url');

const Frame = require('./frame');
const Packet = require('./packet');
const Parser = require('./parser');
const WebSocket = require('./backend').Client;

/**
 * Socket
 */
class Socket extends Events {
  constructor() {
    super();

    this.server = null;
    this.ws = null;
    this.protocol = '';
    this.url = 'ws://127.0.0.1:80/socket.io/?transport=websocket';
    this.ssl = false;
    this.host = '127.0.0.1';
    this.port = 80;
    this.inbound = false;
    this.handshake = false;
    this.opened = false;
    this.connected = false;
    this.challenge = false;
    this.destroyed = false;
    this.reconnection = true;

    this.time = 0;
    this.sequence = 0;
    this.pingInterval = 25000;
    this.pingTimeout = 60000;
    this.lastPing = 0;

    this.parser = new Parser();
    this.binary = false;

    this.packet = null;
    this.timer = null;
    this.jobs = new Map();
    this.hooks = new Map();
    this.channels = new Set();
    this.events = new Events();
    this.buffer = [];

    // Unused.
    // this.admin = false;
    // this.auth = false;
  }

  accept(server, req, socket, ws) {
    Assert(!this.ws, 'Cannot accept twice.');

    Assert(server);
    Assert(req);
    Assert(socket);
    Assert(socket.remoteAddress);
    Assert(socket.remotePort != null);
    Assert(ws);

    let proto = 'ws';
    let host = socket.remoteAddress;
    let port = socket.remotePort;

    if (socket.encrypted)
      proto = 'wss';

    if (host.indexOf(':') !== -1)
      host = `[${host}]`;

    if (!port)
      port = 0;

    this.server = server;
    this.binary = req.url.indexOf('b64=1') === -1;
    this.url = `${proto}://${host}:${port}/socket.io/?transport=websocket`;
    this.ssl = proto === 'wss';
    this.host = socket.remoteAddress;
    this.port = socket.remotePort;
    this.inbound = true;
    this.ws = ws;

    this.init();

    return this;
  }

  connect(port, host, ssl, protocols) {
    Assert(!this.ws, 'Cannot connect twice.');

    if (typeof port === 'string') {
      protocols = host;
      [port, host, ssl] = this._parseURL(port);
    }

    let proto = 'ws';

    if (ssl)
      proto = 'wss';

    if (!host)
      host = '127.0.0.1';

    Assert(typeof host === 'string');
    Assert((port & 0xffff) === port, 'Must pass a port.');
    Assert(!ssl || typeof ssl === 'boolean');
    Assert(!protocols || Array.isArray(protocols));

    let hostname = host;
    if (host.indexOf(':') !== -1 && host[0] !== '[')
      hostname = `[${host}]`;

    const path = '/socket.io';
    const qs = '?transport=websocket';
    const url = `${proto}://${hostname}:${port}${path}/${qs}`;

    this.binary = true;
    this.url = url;
    this.ssl = ssl;
    this.host = host;
    this.port = port;
    this.inbound = false;
    this.ws = new WebSocket(url, protocols);

    this.init();

    return this;
  }

  init() {
    this.protocol = this.ws.protocol;
    this.time = Date.now();
    this.observe();

    this.parser.on('error', (err) => {
      this.emit('error', err);
    });

    this.parser.on('frame', async (frame) => {
      try {
        await this.handleFrame(frame);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.start();
  }

  observe() {
    const ws = this.ws;
    Assert(ws);

    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      await this.onOpen();
    };

    ws.onmessage = async (event) => {
      await this.onMessage(event);
    };

    ws.onerror = async (event) => {
      await this.onError(event);
    };

    ws.onclose = async (event) => {
      await this.onClose(event);
    };
  }

  async onOpen() {
    if (this.destroyed)
      return;

    if (!this.inbound)
      return;

    Assert(!this.opened);
    Assert(!this.connected);
    Assert(!this.handshake);

    this.opened = true;
    this.handshake = true;

    await this.emitAsync('open');

    this.sendHandshake();

    this.connected = true;
    await this.emitAsync('connect');

    this.sendConnect();
  }

  async emitAsync(event, ...args) {
    const handlers = this.listeners(event);

    for (const handler of handlers) {
      try {
        await handler(...args);
      } catch (e) {
        this.emit('error', e);
      }
    }
  }

  async onMessage(event) {
    if (this.destroyed)
      return;

    let data;

    try {
      data = await this._readBinary(event.data);
    } catch (e) {
      this.emit('error', e);
      return;
    }

    // Textual frame.
    if (typeof data === 'string') {
      this.parser.feedString(data);
      return;
    }

    // Binary frame.
    this.parser.feedBinary(data);
  }

  async onError(event) {
    if (this.destroyed)
      return;

    this.emit('error', new Error(event.message));

    if (this.inbound) {
      this.destroy();
      return;
    }

    this.close();
  }

  async onClose(event) {
    if (this.destroyed)
      return;

    if (event.code === 1000 || event.code === 1001) {
      if (!this.connected)
        this.emit('error', new Error('Could not connect.'));

      if (this.inbound) {
        this.destroy();
        return;
      }

      this.close();

      return;
    }

    const code = Socket.CODES[event.code] || 'UNKNOWN_CODE';
    const reason = event.reason || 'Unknown reason';
    const msg = `Websocket Closed: ${reason} (code=${code}).`;

    const err = new Error(msg);
    err.reason = event.reason || '';
    err.code = event.code || 0;

    this.emit('error', err);

    if (this.inbound) {
      this.destroy();
      return;
    }

    if (!this.reconnection) {
      this.destroy();
      return;
    }

    this.close();
  }

  close() {
    if (this.destroyed)
      return;

    this.time = Date.now();
    this.packet = null;
    this.handshake = false;
    this.connected = false;
    this.challenge = false;
    this.sequence = 0;
    this.lastPing = 0;

    for (const [id, job] of this.jobs) {
      this.jobs.delete(id);
      job.reject(new Error('Job timed out.'));
    }

    Assert(this.ws);
    this.ws.onopen = () => {};
    this.ws.onmessage = () => {};
    this.ws.onerror = () => {};
    this.ws.onclose = () => {};
    this.ws.close();

    this.emitAsync('disconnect');
  }

  error(msg) {
    if (this.destroyed)
      return;

    this.emit('error', new Error(msg));
  }

  destroy() {
    if (this.destroyed)
      return;

    this.close();
    this.stop();

    this.opened = false;
    this.destroyed = true;
    this.buffer.length = 0;

    this.emitAsync('close');

    this.removeAllListeners();
    this.on('error', () => {});
  }

  send(frame) {
    if (this.destroyed)
      return;

    Assert(this.ws);

    if (frame.binary && this.binary)
      this.ws.send(frame.toRaw());
    else
      this.ws.send(frame.toString());
  }

  reconnect() {
    Assert(!this.inbound);
    this.close();
    this.ws = new WebSocket(this.url);
    this.time = Date.now();
    this.observe();
  }

  start() {
    Assert(this.ws);
    Assert(this.timer == null);
    this.timer = setInterval(() => this.stall(), 5000);
  }

  stop() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stall() {
    const now = Date.now();

    Assert(this.ws);

    if (!this.connected) {
      if (now - this.time > 10000) {
        if (this.inbound || !this.reconnection) {
          this.error('Timed out waiting for connection.');
          this.destroy();
          return;
        }

        this.error('Timed out waiting for connection. Reconnecting...');
        this.reconnect();

        return;
      }

      return;
    }

    for (const [id, job] of this.jobs) {
      if (now - job.time > 600000) {
        this.jobs.delete(id);
        job.reject(new Error('Job timed out.'));
      }
    }

    if (!this.inbound && !this.challenge) {
      this.challenge = true;
      this.lastPing = now;
      this.sendPing();
      return;
    }

    if (!this.inbound && now - this.lastPing > this.pingTimeout) {
      this.error('Connection is stalling (ping).');

      if (this.inbound) {
        this.destroy();
        return;
      }

      this.close();

      return;
    }
  }

  /*
   * Frames
   */
  async handleFrame(frame) {
    if (this.destroyed)
      return undefined;

    switch (frame.type) {
      case Frame.TYPES.OPEN:
        return this.handleOpen(frame);
      case Frame.TYPES.CLOSE:
        return this.handleClose(frame);
      case Frame.TYPES.PING:
        return this.handlePing(frame);
      case Frame.TYPES.PONG:
        return this.handlePong(frame);
      case Frame.TYPES.MESSAGE:
        return this.handleMessage(frame);
      case Frame.TYPES.UPGRADE:
        return this.handleUpgrade(frame);
      case Frame.TYPES.NOOP:
        return this.handleNoop(frame);
      default: {
        throw new Error('Unknown frame.');
      }
    }
  }

  async handleOpen(frame) {
    if (this.inbound)
      throw new Error('Inbound socket sent an open frame.');

    if (frame.binary)
      throw new Error('Received a binary open frame.');

    if (this.handshake)
      throw new Error('Duplicate open frame.');

    const json = JSON.parse(frame.data);

    Enforce(json && typeof json === 'object', 'open', 'object');

    const {pingInterval, pingTimeout} = json;

    Enforce((pingInterval >>> 0) === pingInterval, 'interval', 'uint32');
    Enforce((pingTimeout >>> 0) === pingTimeout, 'timeout', 'uint32');

    this.pingInterval = pingInterval;
    this.pingTimeout = pingTimeout;
    this.handshake = true;

    if (!this.opened) {
      this.opened = true;
      await this.emitAsync('open');
    }
  }

  async handleClose(frame) {
    if (this.inbound)
      throw new Error('Inbound socket sent a close frame.');

    this.close();
  }

  async handlePing() {
    if (!this.inbound)
      throw new Error('Outbound socket sent a ping frame.');

    this.sendPong();
  }

  async handlePong() {
    if (this.inbound)
      throw new Error('Inbound socket sent a pong frame.');

    if (!this.challenge) {
      this.error('Remote node sent bad pong.');
      this.destroy();
      return;
    }

    this.challenge = false;
  }

  async handleMessage(frame) {
    if (this.packet) {
      const packet = this.packet;

      if (!frame.binary)
        throw new Error('Received non-binary frame as attachment.');

      packet.buffers.push(frame.data);

      if (packet.buffers.length === packet.attachments) {
        this.packet = null;
        return this.handlePacket(packet);
      }

      return undefined;
    }

    if (frame.binary)
      throw new Error('Received binary frame as a message.');

    const packet = Packet.fromString(frame.data);

    if (packet.attachments > 0) {
      this.packet = packet;
      return undefined;
    }

    return this.handlePacket(packet);
  }

  async handleUpgrade(frame) {
    if (!this.inbound)
      throw new Error('Outbound socket sent an upgrade frame.');
    throw new Error('Cannot upgrade from websocket.');
  }

  async handleNoop(frame) {
    ;
  }

  sendFrame(type, data, binary) {
    this.send(new Frame(type, data, binary));
  }

  sendOpen(data) {
    this.sendFrame(Frame.TYPES.OPEN, data, false);
  }

  sendClose(data) {
    this.sendFrame(Frame.TYPES.CLOSE, data, false);
  }

  sendPing(data) {
    this.sendFrame(Frame.TYPES.PING, data, false);
  }

  sendPong(data) {
    this.sendFrame(Frame.TYPES.PONG, data, false);
  }

  sendMessage(data) {
    this.sendFrame(Frame.TYPES.MESSAGE, data, false);
  }

  sendBinary(data) {
    this.sendFrame(Frame.TYPES.MESSAGE, data, true);
  }

  sendHandshake() {
    const handshake = JSON.stringify({
      sid: '00000000000000000000',
      upgrades: [],
      pingInterval: this.pingInterval,
      pingTimeout: this.pingTimeout
    });

    this.sendOpen(handshake);
  }

  /*
   * Packets
   */
  async handlePacket(packet) {
    if (this.destroyed)
      return undefined;

    switch (packet.type) {
      case Packet.TYPES.CONNECT: {
        return this.handleConnect();
      }
      case Packet.TYPES.DISCONNECT: {
        return this.handleDisconnect();
      }
      case Packet.TYPES.EVENT:
      case Packet.TYPES.BINARY_EVENT: {
        const args = packet.getData();

        Enforce(Array.isArray(args), 'args', 'array');
        Enforce(args.length > 0, 'args', 'array');
        Enforce(typeof args[0] === 'string', 'event', 'string');

        if (packet.id !== -1)
          return this.handleCall(packet.id, args);

        return this.handleEvent(args);
      }
      case Packet.TYPES.ACK:
      case Packet.TYPES.BINARY_ACK: {
        Enforce(packet.id !== -1, 'id', 'uint32');

        const json = packet.getData();

        Enforce(json == null || Array.isArray(json), 'args', 'array');

        let err = null;
        let result = null;

        if (json && json.length > 0)
          err = json[0];

        if (json && json.length > 1)
          result = json[1];

        if (result == null)
          result = null;

        if (err) {
          Enforce(typeof err === 'object', 'error', 'object');
          return this.handleError(packet.id, err);
        }

        return this.handleAck(packet.id, result);
      }
      case Packet.TYPES.ERROR: {
        const err = packet.getData();
        Enforce(err && typeof err === 'object', 'error', 'object');
        return this.handleError(-1, err);
      }
      default: {
        throw new Error('Unknown packet.');
      }
    }
  }

  async handleConnect() {
    if (this.inbound)
      throw new Error('Inbound socket sent connect packet.');

    this.connected = true;

    await this.emitAsync('connect');

    for (const packet of this.buffer)
      this.sendPacket(packet);

    this.buffer.length = 0;
  }

  async handleDisconnect() {
    this.close();
  }

  async handleEvent(args) {
    try {
      const event = args[0];

      if (this._isReserved(event))
        throw new Error(`Cannot emit reserved event: ${event}.`);

      this.events.emit(...args);
    } catch (e) {
      this.emit('error', e);
      this.sendError(-1, e);
    }
  }

  async handleCall(id, args) {
    let result;

    try {
      const event = args.shift();

      if (this._isReserved(event))
        throw new Error(`Cannot emit reserved event: ${event}.`);

      const handler = this.hooks.get(event);

      if (!handler)
        throw new Error(`Call not found: ${event}.`);

      result = await handler(...args);
    } catch (e) {
      this.emit('error', e);
      this.sendError(id, e);
      return;
    }

    if (result == null)
      result = null;

    this.sendAck(id, result);
  }

  async handleAck(id, data) {
    const job = this.jobs.get(id);

    if (!job)
      throw new Error(`Job not found for ${id}.`);

    this.jobs.delete(id);

    job.resolve(data);
  }

  async handleError(id, err) {
    const msg = this._castMsg(err.message);
    const code = this._castCode(err.code);
    const type = this._castType(err.type);

    if (id === -1) {
      const e = new Error(msg);
      e.code = code;
      e.type = type;
      this.emit('error', e);
      return;
    }

    const job = this.jobs.get(id);

    if (!job)
      throw new Error(`Job not found for ${id}.`);

    this.jobs.delete(id);

    const e = new Error(msg);
    e.code = code;
    e.type = type;

    job.reject(e);
  }

  sendPacket(packet) {
    this.sendMessage(packet.toString());

    for (const data of packet.buffers)
      this.sendBinary(data);
  }

  sendConnect() {
    this.sendPacket(new Packet(Packet.TYPES.CONNECT));
  }

  sendDisconnect() {
    this.sendPacket(new Packet(Packet.TYPES.DISCONNECT));
  }

  sendEvent(data) {
    const packet = new Packet();

    packet.type = Packet.TYPES.EVENT;
    packet.setData(data);

    if (!this.connected) {
      this.buffer.push(packet);
      return;
    }

    this.sendPacket(packet);
  }

  sendCall(id, data) {
    const packet = new Packet();

    packet.type = Packet.TYPES.EVENT;
    packet.id = id;
    packet.setData(data);

    if (!this.connected) {
      this.buffer.push(packet);
      return;
    }

    this.sendPacket(packet);
  }

  sendAck(id, data) {
    const packet = new Packet();
    packet.type = Packet.TYPES.ACK;
    packet.id = id;
    packet.setData([null, data]);
    this.sendPacket(packet);
  }

  sendError(id, err) {
    const message = this._castMsg(err.message);
    const code = this._castCode(err.code);
    const type = this._castType(err.type);

    if (id === -1) {
      const packet = new Packet();
      packet.type = Packet.TYPES.ERROR;
      packet.setData({ message, code, type });
      this.sendPacket(packet);
      return;
    }

    const packet = new Packet();
    packet.type = Packet.TYPES.ACK;
    packet.id = id;
    packet.setData([{ message, code, type }]);
    this.sendPacket(packet);
  }

  /*
   * API
   */
  bind(event, handler) {
    Enforce(typeof event === 'string', 'event', 'string');
    Enforce(typeof handler === 'function', 'handler', 'function');
    Assert(!this._isReserved(event), 'Reserved event.');
    this.events.on(event, handler);
  }

  unbind(event, handler) {
    Enforce(typeof event === 'string', 'event', 'string');
    Enforce(typeof handler === 'function', 'handler', 'function');
    Assert(!this._isReserved(event), 'Reserved event.');
    this.events.removeListener(event, handler);
  }

  fire(...args) {
    Enforce(args.length > 0, 'event', 'string');
    Enforce(typeof args[0] === 'string', 'event', 'string');
    this.sendEvent(args);
  }

  hook(event, handler) {
    Enforce(typeof event === 'string', 'event', 'string');
    Enforce(typeof handler === 'function', 'handler', 'function');
    Assert(!this.hooks.has(event), 'Hook already bound.');
    Assert(!this._isReserved(event), 'Reserved event.');
    this.hooks.set(event, handler);
  }

  unhook(event) {
    Enforce(typeof event === 'string', 'event', 'string');
    Enforce(typeof handler === 'function', 'handler', 'function');
    Assert(!this._isReserved(event), 'Reserved event.');
    this.hooks.delete(event);
  }

  call(...args) {
    Enforce(args.length > 0, 'event', 'string');
    Enforce(typeof args[0] === 'string', 'event', 'string');

    const id = this.sequence;

    this.sequence += 1;
    this.sequence >>>= 0;

    Assert(!this.jobs.has(id), 'ID collision.');

    this.sendCall(id, args);

    return new Promise((resolve, reject) => {
      this.jobs.set(id, new Job(resolve, reject, Date.now()));
    });
  }

  channel(name) {
    return this.channels.has(name);
  }

  join(name) {
    if (!this.server)
      return false;
    return this.server.join(this, name);
  }

  leave(name) {
    if (!this.server)
      return false;
    return this.server.leave(this, name);
  }

  _isReserved(event) {
    return Socket.RESERVED_EVENT.hasOwnProperty(event);
  }

  _parseURL(url) {
    if (url.indexOf('://') === -1)
      url = `ws://${url}`;

    const data = URL.parse(url);

    if (data.protocol !== 'http:'
        && data.protocol !== 'https:'
        && data.protocol !== 'ws:'
        && data.protocol !== 'wss:') {
      throw new Error('Invalid protocol for websocket URL.');
    }

    if (!data.hostname)
      throw new Error('Malformed URL.');

    const host = data.hostname;

    let port = 80;
    let ssl = false;

    if (data.protocol === 'https:' || data.protocol === 'wss:') {
      port = 443;
      ssl = true;
    }

    if (data.port) {
      port = parseInt(data.port, 10);
      Assert((port & 0xffff) === port);
      Assert(port !== 0);
    }

    return [port, host, ssl];
  }

  _castCode(code) {
    if (code !== null
        && typeof code !== 'number'
        && typeof code !== 'string') {
      return null;
    }
    return code;
  }

  _castMsg(msg) {
    if (typeof msg !== 'string')
      return 'No message.';
    return msg;
  }

  _castType(type) {
    if (typeof type !== 'string')
      return null;
    return type;
  }

  /**
   * @return {Promise}
   */
  _readBinary(data) {
    return new Promise((resolve, reject) => {
      if (typeof data === 'string') {
        resolve(data);
        return;
      }

      if (!data || typeof data !== 'object') {
        reject(new Error('Bad data object.'));
        return;
      }

      if (Buffer.isBuffer(data)) {
        resolve(data);
        return;
      }

      if (data instanceof ArrayBuffer) {
        const result = Buffer.from(data);
        resolve(result);
        return;
      }

      if (data.buffer instanceof ArrayBuffer) {
        const result = Buffer.from(data.buffer);
        resolve(result);
        return;
      }

      /* global Blob, FileReader */
      if (typeof Blob !== 'undefined' && Blob) {
        if (data instanceof Blob) {
          const reader = new FileReader();
          reader.onloadend = () => {
            const result = Buffer.from(reader.result);
            resolve(result);
          };
          reader.readAsArrayBuffer(data);
          return;
        }
      }

      reject(new Error('Bad data object.'));
    });
  }

  static accept(server, req, socket, ws) {
    return new this().accept(server, req, socket, ws);
  }

  static connect(port, host, ssl, protocols) {
    return new this().connect(port, host, ssl, protocols);
  }
}

/*
 * Helpers
 */
class Job {
  constructor(resolve, reject, time) {
    this.resolve = resolve;
    this.reject = reject;
    this.time = time;
  }
}

function Enforce(value, name, type) {
  if (!value) {
    const err = new TypeError(`'${name}' must be a(n) ${type}.`);
    if (Error.captureStackTrace)
      Error.captureStackTrace(err, Enforce);
    throw err;
  }
}

/*
 * Constants
 */
Socket.RESERVED_EVENT = {
  connect: true,
  connect_error: true,
  connect_timeout: true,
  connecting: true,
  disconnect: true,
  error: true,
  reconnect: true,
  reconnect_attempt: true,
  reconnect_failed: true,
  reconnect_error: true,
  reconnecting: true,
  ping: true,
  pong: true
};

Socket.CODES = {
  1000: 'NORMAL_CLOSURE',
  1001: 'GOING_AWAY',
  1002: 'PROTOCOL_ERROR',
  1003: 'UNSUPPORTED_DATA',
  1004: 'RESERVED',
  1005: 'NO_STATUS_RECVD',
  1006: 'ABNORMAL_CLOSURE',
  1007: 'INVALID_FRAME_PAYLOAD_DATA',
  1008: 'POLICY_VIOLATION',
  1009: 'MESSAGE_TOO_BIG',
  1010: 'MISSING_EXTENSION',
  1011: 'INTERNAL_ERROR',
  1012: 'SERVICE_RESTART',
  1013: 'TRY_AGAIN_LATER',
  1014: 'BAD_GATEWAY',
  1015: 'TLS_HANDSHAKE'
};

/*
 * Expose
 */
module.exports = Socket;