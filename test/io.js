'use strict';

process.on('unhandledRejection', (err, promise) => {
  throw err;
});

const SocketIO = require('socket.io');
const HTTP = require('http');
const Socket = require('../');
const Server = HTTP.createServer();

function timeout(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const IO = new SocketIO({
  transports: ['websocket'],
  serveClient: false
});

IO.attach(Server);

IO.on('connection', (socket) => {
  socket.on('foo', async (cb) => {
    const result = Buffer.from('test', 'ascii');
    await timeout(3000);
    cb(null, result);
  });
  socket.on('err', (cb) => {
    cb({ message: 'Bad call.' });
  });
  socket.on('bar', (data) => {
    console.log('Received bar: %s', data.toString('ascii'));
  });
});

Server.listen(8000);

const socket = Socket.connect(8000);

socket.on('error', () => {});
socket.on('connect', async () => {
  console.log('Calling foo...');

  const data = await socket.call('foo');
  console.log('Response for foo: %s', data.toString('ascii'));

  console.log('Sending bar...');

  socket.fire('bar', Buffer.from('baz'));

  console.log('Sending error...');

  try {
    await socket.call('err');
  } catch (e) {
    console.log('Response for error: %s', e.message);
  }
});