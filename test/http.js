'use strict';

process.on('unhandledRejection', (err, promise) => {
  throw err;
});

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
  socket.bind('join', (name) => {
    IO.join(socket, name);
    IO.to(name, 'test', 'testing');
    IO.leave(socket, name);
    IO.to(name, 'test', 'testing again');
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

  socket.bind('test', (str) => {
    console.log(str);
  });

  socket.fire('join', 'test-channel');
});