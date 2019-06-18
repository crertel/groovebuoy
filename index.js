require('dotenv').config();

const express = require('express');
const http = require('http');
const SocketIO = require('socket.io');
const PeerServer = require('./models/peer-server');

// Spin up our webserver
const app = express();
const server = http.createServer(app);
const io = SocketIO(server);
const peerServer = new PeerServer({socket: io});

server.listen(8000, () => {
  console.log('Server is listening on port 8000');
});
