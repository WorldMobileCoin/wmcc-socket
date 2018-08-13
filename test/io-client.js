'use strict';

process.on('unhandledRejection', (err, promise) => {
  throw err;
});

const SocketIO = require('socket.io-client');
const HTTP = require('http');
const Socket = require('../');
const IO = Socket.createServer();
const Server = HTTP.createServer();

function timeout(ms) {
  return new Promise(r => setTimeout(r, ms));
}

IO.attach(Server);

IO.on('socket', (socket) => {
  socket.on('error', () => {});
  socket.hook('foo', async () => {
    const result = Buffer.from('test', 'ascii');
    await timeout(3000);
    return result;
  });
  socket.hook('err', async () => {
    throw new Error('Bad call.');
  });
  socket.bind('bar', (data) => {
    console.log('Received bar: %s', data.toString('ascii'));
  });
});

Server.listen(8000);

const socket = new SocketIO('ws://127.0.0.1:8000', {
  transports: ['websocket'],
  forceNew: true
});

console.log('Calling foo...');

socket.emit('foo', (err, data) => {
  console.log('Response for foo: %s', data.toString('ascii'));
});

console.log('Sending bar...');

socket.emit('bar', Buffer.from('baz'));

console.log('Sending error...');

socket.emit('err', (err) => {
  console.log('Response for error: %s', err.message);
});