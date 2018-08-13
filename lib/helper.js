'use strict';

const Assert = require('assert');

exports.isPlaceholder = function(obj) {
  return obj !== null
    && typeof obj === 'object'
    && obj._placeholder === true
    && (obj.num >>> 0) === obj.num;
};

exports.deconstruct = function(obj) {
  const buffers = [];
  const out = exports.replace(obj, buffers);
  const str = JSON.stringify(out);
  return [str, buffers];
}

exports.replace = function(obj, buffers) {
  if (Buffer.isBuffer(obj)) {
    const out = { _placeholder: true, num: buffers.length };
    buffers.push(obj);
    return out;
  }

  if (Array.isArray(obj)) {
    const out = [];
    for (let i = 0; i < obj.length; i++)
      out.push(exports.replace(obj[i], buffers));
    return out;
  }

  if (obj && typeof obj === 'object') {
    const out = Object.create(null);
    for (const key of Object.keys(obj))
      out[key] = exports.replace(obj[key], buffers);
    return out;
  }

  return obj;
}

exports.reconstruct = function(str, buffers) {
  return JSON.parse(str, (key, value) => {
    if (exports.isPlaceholder(value)) {
      Assert(value.num < buffers.length);
      return buffers[value.num];
    }
    return value;
  });
}

exports.readChar = function(str, i) {
  const ch = str.charCodeAt(i) - 0x30;

  if (ch < 0 || ch > 9)
    return -1;

  return [i + 1, ch];
}

exports.readInt = function(str, i) {
  let len = 0;
  let num = 0;

  for (; i < str.length; i++) {
    const ch = str.charCodeAt(i) - 0x30;

    if (ch < 0 || ch > 9)
      break;

    num *= 10;
    num += ch;
    len += 1;

    Assert(len <= 10);
  }

  Assert(num <= 0xffffffff);

  if (len === 0)
    num = -1;

  return [i, num];
}

exports.readTo = function(str, i, ch) {
  let j = i;

  for (; j < str.length; j++) {
    if (str[j] === ch)
      break;
  }

  Assert(j < str.length);

  return [j + 1, str.substring(i, j)];
}