'use strict';

const Assert = require('assert');
const Helper = require('./helper');

class Packet {
  constructor(type) {
    this.type = type || 0;
    this.attachments = 0;
    this.nsp = '/';
    this.id = -1;
    this.data = '';
    this.buffers = [];
  }

  setData(data) {
    Assert(data !== undefined);
    Assert(typeof data !== 'number');
    Assert(typeof data !== 'function');

    const [str, buffers] = Helper.deconstruct(data);

    this.data = str;
    this.buffers = buffers;
    this.attachments = buffers.length;

    if (this.attachments > 0) {
      switch (this.type) {
        case Packet.TYPES.EVENT:
          this.type = Packet.TYPES.BINARY_EVENT;
          break;
        case Packet.TYPES.ACK:
          this.type = Packet.TYPES.BINARY_ACK;
          break;
      }
    }

    return this;
  }

  getData() {
    if (this.data.length === 0)
      return null;
    return Helper.reconstruct(this.data, this.buffers);
  }

  toString() {
    let str = this.type.toString(10);

    switch (this.type) {
      case Packet.TYPES.BINARY_EVENT:
      case Packet.TYPES.BINARY_ACK:
        str += this.attachments.toString(10) + '-';
        break;
    }

    if (this.nsp !== '/')
      str += this.nsp + ',';

    if (this.id !== -1)
      str += this.id.toString(10);

    str += this.data;

    return str;
  }

  static fromString(str) {
    Assert(typeof str === 'string');
    Assert(str.length > 0);

    let i = 0;
    let type = 0;
    let attachments = 0;
    let nsp = '/';
    let id = -1;
    let data = '';

    [i, type] = Helper.readChar(str, i);

    Assert(type !== -1);
    Assert(type <= Packet.TYPES.BINARY_ACK);

    switch (type) {
      case Packet.TYPES.BINARY_EVENT:
      case Packet.TYPES.BINARY_ACK: {
        [i, attachments] = Helper.readInt(str, i);
        Assert(attachments !== -1);
        Assert(i < str.length);
        Assert(str[i] === '-');
        i += 1;
        break;
      }
    }

    if (i < str.length && str[i] === '/')
      [i, nsp] = Helper.readTo(str, i, ',');

    [i, id] = Helper.readInt(str, i);

    if (i < str.length)
      data = str.substring(i);

    const packet = new this();
    packet.type = type;
    packet.attachments = attachments;
    packet.nsp = nsp;
    packet.id = id;
    packet.data = data;

    return packet;
  }
}

/**
 * Constants
 */
Packet.TYPES = {
  CONNECT: 0,
  DISCONNECT: 1,
  EVENT: 2,
  ACK: 3,
  ERROR: 4,
  BINARY_EVENT: 5,
  BINARY_ACK: 6
}

/*
 * Expose
 */
module.exports = Packet;