'use strict';

const Assert = require('assert');
const Events = require('events');
const Frame = require('./frame');

class Parser extends Events {
  constructor() {
    super();
  }

  error(msg) {
    this.emit('error', new Error(msg));
  }

  feedBinary(data) {
    Assert(Buffer.isBuffer(data));

    if (data.length > Parser.MAX_MESSAGE) {
      this.error('Frame too large.');
      return;
    }

    let frame;
    try {
      frame = Frame.fromRaw(data);
    } catch (e) {
      this.emit('error', e);
      return;
    }

    this.emit('frame', frame);
  }

  feedString(data) {
    Assert(typeof data === 'string');

    if (Buffer.byteLength(data, 'utf8') > Parser.MAX_MESSAGE) {
      this.error('Frame too large.');
      return;
    }

    let frame;
    try {
      frame = Frame.fromString(data);
    } catch (e) {
      this.emit('error', e);
      return;
    }

    this.emit('frame', frame);
  }
}

/*
 * Constant
 */
Parser.MAX_MESSAGE = 100000000;

/*
 * Expose
 */
module.exports = Parser;