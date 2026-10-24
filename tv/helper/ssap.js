// A small client for the TV's own network remote service (SSAP, the API phone remote apps
// use), for Node 8 on the TV, which has no WebSocket client. It connects to the TV itself,
// registers with an already-approved client key, and sends requests and remote buttons.
'use strict';

const crypto = require('crypto');
const net = require('net');
const EventEmitter = require('events');

// A minimal WebSocket client: text frames only, which is all SSAP uses.
class Socket extends EventEmitter {
  constructor(host, port, path) {
    super();
    this.buffer = Buffer.alloc(0);
    this.open = false;
    const key = crypto.randomBytes(16).toString('base64');
    this.sock = net.createConnection(port, host, () => {
      this.sock.write('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    this.sock.on('data', (chunk) => this.onData(chunk));
    this.sock.on('error', (err) => this.emit('error', err));
    this.sock.on('close', () => this.emit('close'));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.open) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = this.buffer.slice(0, end).toString();
      this.buffer = this.buffer.slice(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head)) {
        this.emit('error', new Error('handshake refused: ' + head.split('\r\n')[0]));
        this.sock.destroy();
        return;
      }
      this.open = true;
      this.emit('open');
    }
    // Server frames are unmasked; a frame is FIN/opcode, length, payload.
    while (this.buffer.length >= 2) {
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = this.buffer.readUInt32BE(6);
        offset = 10;
      }
      if (this.buffer.length < offset + len) return;
      const payload = this.buffer.slice(offset, offset + len);
      this.buffer = this.buffer.slice(offset + len);
      if (opcode === 1) this.emit('message', payload.toString());
      else if (opcode === 8) this.sock.end();
      else if (opcode === 9) this.frame(10, payload);
    }
  }

  // Client frames must be masked.
  frame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    let head;
    if (payload.length < 126) {
      head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    } else {
      head = Buffer.alloc(4);
      head[0] = 0x80 | opcode;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(payload.length, 2);
    }
    const body = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) body[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, body]));
  }

  send(text) {
    this.frame(1, Buffer.from(text));
  }

  close() {
    this.sock.destroy();
  }
}

// SSAP over the socket: register, then request/response by id.
class Remote extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;   // { host, port, pairing, clientKey }
    this.next = 0;
    this.pending = new Map();
    this.ready = null;
    this.buttons = null;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new Socket(this.opts.host, this.opts.port, '/');
      this.ws = ws;
      ws.on('open', () => {
        const payload = Object.assign({}, this.opts.pairing, { 'client-key': this.opts.clientKey });
        ws.send(JSON.stringify({ type: 'register', id: 'register', payload: payload }));
      });
      ws.on('message', (text) => {
        let msg;
        try {
          msg = JSON.parse(text);
        } catch (e) {
          return;
        }
        if (msg.id === 'register') {
          if (msg.type === 'registered') resolve(this);
          else if (msg.type === 'error') reject(new Error(msg.error || 'registration refused'));
          return;
        }
        const done = this.pending.get(msg.id);
        if (!done) return;
        this.pending.delete(msg.id);
        if (msg.type === 'error' || (msg.payload && msg.payload.returnValue === false)) done.reject(new Error(msg.error || (msg.payload && msg.payload.errorText) || 'request failed'));
        else done.resolve(msg.payload || {});
      });
      const fail = (err) => {
        this.ready = null;
        this.buttons = null;
        reject(err || new Error('connection closed'));
        this.pending.forEach((p) => p.reject(new Error('connection closed')));
        this.pending.clear();
      };
      ws.on('error', fail);
      ws.on('close', () => fail());
    });
    return this.ready;
  }

  request(uri, payload) {
    return this.connect().then(() => new Promise((resolve, reject) => {
      const id = 'req' + (++this.next);
      this.pending.set(id, { resolve: resolve, reject: reject });
      this.ws.send(JSON.stringify({ type: 'request', id: id, uri: uri, payload: payload || {} }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('no answer to ' + uri));
      }, 8000);
    }));
  }

  // Remote buttons go through a second socket the TV hands out.
  button(name) {
    const send = () => this.buttons.send('type:button\nname:' + name + '\n\n');
    if (this.buttons && this.buttons.open) {
      send();
      return Promise.resolve();
    }
    return this.request('ssap://com.webos.service.networkinput/getPointerInputSocket').then((res) => new Promise((resolve, reject) => {
      const url = /^wss?:\/\/([^/:]+)(?::(\d+))?(\/.*)$/.exec(res.socketPath || '');
      if (!url) return reject(new Error('no button socket'));
      const ws = new Socket(this.opts.host, this.opts.port, url[3]);
      ws.on('open', () => {
        this.buttons = ws;
        send();
        resolve();
      });
      ws.on('error', reject);
      ws.on('close', () => {
        if (this.buttons === ws) this.buttons = null;
      });
    }));
  }
}

module.exports = { Remote: Remote };
