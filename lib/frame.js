'use strict';

const Assert = require('assert');
const DUMMY = Buffer.alloc(0);

class Frame {
  constructor(type, data, binary) {
    Assert(typeof type === 'number');
    Assert((type >>> 0) === type);
    Assert(type <= Frame.TYPES.NOOP);
    Assert(typeof binary === 'boolean');

    if (binary) {
      if (data == null)
        data = DUMMY;
      Assert(Buffer.isBuffer(data));
    } else {
      if (data == null)
        data = '';
      Assert(typeof data === 'string');
    }

    this.type = type;
    this.data = data;
    this.binary = binary;
  }

  toString() {
    let str = '';

    if (this.binary) {
      str += 'b';
      str += this.type.toString(10);
      str += this.data.toString('base64');
    } else {
      str += this.type.toString(10);
      str += this.data;
    }

    return str;
  }

  static fromString(str) {
    Assert(typeof str === 'string');

    let type = str.charCodeAt(0);
    let binary = false;
    let data;

    // 'b' - base64
    if (type === 0x62) {
      Assert(str.length > 1);
      type = str.charCodeAt(1);
      data = Buffer.from(str.substring(2), 'base64');
      binary = true;
    } else {
      data = str.substring(1);
    }

    type -= 0x30;
    Assert(type >= 0 && type <= 9);
    Assert(type <= Frame.TYPES.NOOP);

    return new this(type, data, binary);
  }

  size() {
    let len = 1;

    if (this.binary)
      len += this.data.length;
    else
      len += Buffer.byteLength(this.data, 'utf8');

    return len;
  }

  toRaw() {
    const data = Buffer.allocUnsafe(this.size());

    data[0] = this.type;

    if (this.binary) {
      this.data.copy(data, 1);
    } else {
      if (this.data.length > 0)
        data.write(this.data, 1, 'utf8');
    }

    return data;
  }

  static fromRaw(data) {
    Assert(Buffer.isBuffer(data));
    Assert(data.length > 0);

    const type = data[0];
    Assert(type <= Frame.TYPES.NOOP);

    return new this(type, data.slice(1), true);
  }
}

/*
 * Constants
 */
Frame.TYPES = {
  OPEN: 0,
  CLOSE: 1,
  PING: 2,
  PONG: 3,
  MESSAGE: 4,
  UPGRADE: 5,
  NOOP: 6
};

// Unused.
/*Frame.TABLE = [
  'open',
  'close',
  'ping',
  'pong',
  'message',
  'upgrade',
  'noop'
];*/

/*
 * Expose
 */
module.exports = Frame;