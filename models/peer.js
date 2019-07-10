const uuid = require('uuid/v1');
const JWT = require('jsonwebtoken');

// Peers have 5000 seconds to authenticate before getting das boot
const AUTH_TIMEOUT = 5000;

class Peer {
  constructor({socket, server}) {
    this.socket = socket;
    this.server = server;
    this.currentRoom = null;
    this.profile = null;
    this.id = null;

    // They have 5 seconds to authenticate
    this.authTimeout = setTimeout(this._closeUnauthenticated, 5000);

    this.socket.on('call', this._handleMessage);
    this.socket.on('disconnect', this._handleDisconnect);

    this.rpcMethods = {
      authenticate: this.authenticate,
      becomeDj: this.becomeDj,
      createRoom: this.createRoom,
      fetchRooms: this.fetchRooms,
      join: this.join,
      joinRoom: this.joinRoom,
      leaveRoom: this.leaveRoom,
      sendChat: this.sendChat,
      setProfile: this.setProfile,
      skipTurn: this.skipTurn,
      stepDown: this.stepDown,
      trackEnded: this.trackEnded,
      updatedQueue: this.updatedQueue,
      vote: this.vote,
    };
  }

  ////
  // Socket events
  //
  _handleMessage = ({name, params}, respond) => {
    const method = this.rpcMethods[name];
    if (method) {
      const id = this.id ? this.id.split('-')[0] : 'unauth';
      console.log(`[RCV ${id}]: ${name}`);
      Promise.resolve(method(params))
        .then(v => respond(v))
        .catch(e => respond({error: true, message: e.toString()}));
    } else {
      console.log(`[RCV] Invalid call: ${name}`);
      respond({error: true, message: 'Invalid method name'});
    }
  }

  _handleDisconnect = () => {
    if (this.currentRoom) {
      this.currentRoom.removePeer({peer: this});
    }

    this.server.removePeer({peer: this});
    console.log('Connection closed');
  };

  _closeUnauthenticated = () => {
    console.log('Closing unauthenticated peer');
    this.socket.disconnect();
  }

  ////
  // RPC Commands
  //
  join = async ({jwt}) => {
    let invite;
    try {
      invite = JWT.verify(jwt, process.env.JWT_SECRET);
    } catch (e) {
      return {error: true, message: 'invalid token'};
    }

    if (invite.u !== this.server.wsUrl || invite.n !== this.server.name) {
      return {error: true, message: 'invalid token'};
    }

    this.id = uuid();

    // Generate an auth token
    const token = JWT.sign({
      // URL
      u: this.server.ws_url,
      // Server name
      n: this.server.name,
      // ID
      i: this.id,
    }, process.env.JWT_SECRET);

    clearTimeout(this.authTimeout);

    return {token, peerId: this.id};
  }

  authenticate = async ({jwt}) => {
    const token = JWT.verify(jwt, process.env.JWT_SECRET);
    if (token.u !== this.server.wsUrl || token.n !== this.server.name) {
      return {error: true, message: 'invalid token'};
    }

    this.id = token.i;

    clearTimeout(this.authTimeout);

    return {peerId: this.id};
  }

  fetchRooms = () => {
    return this.server.rooms.map(r => r.serialize());
  }

  joinRoom = ({id}) => {
    const room = this.server.rooms.find(r => r.id === id);
    if (!room) return {error: true, message: 'room not found'};

    this.currentRoom = room;
    this.currentRoom.addPeer({peer: this});

    return {
      ...room.serialize({includePeers: true}),
    };
  }

  leaveRoom = () => {
    if (!this.currentRoom) {
      return {error: true, message: 'you are not in a room'};
    }

    this.currentRoom.removePeer({peer: this});
    return {success: true};
  }

  createRoom = ({name}) => {
    if (name.length === 0) {
      return {error: true, message: 'name must be at least 1 character'};
    }

    return this.server.createRoom({name}).serialize();
  }

  becomeDj = () => {
    if (!this.currentRoom) {
      return {error: true, message: 'must be in a room to promote'};
    }

    if (!this.currentRoom.addDj({peer: this})) {
      return {error: true, message: 'could not promote'};
    }

    return {success: true};
  }

  stepDown = () => {
    if (!this.currentRoom) {
      return {error: true, message: 'must be in a room to step down'};
    }

    const success = this.currentRoom.removeDj({peer: this});
    if (!success) {
      return {error: true, message: 'must be a dj to step down'};
    }

    return {success: true};
  }

  trackEnded = () => {
    if (!this.currentRoom) {
      return {error: true, message: 'must be in a room to end a track'};
    }

    if (this.currentRoom.activeDj !== this) {
      return {error: true, message: 'must be the active dj to end the track'};
    }

    this.currentRoom.endTrack();

    return {success: true};
  }

  setProfile = ({profile}) => {
    this.profile = profile;

    if (this.currentRoom) {
      this.currentRoom.broadcast({
        name: 'setPeerProfile',
        params: {id: this.id, profile},
      });
    }

    return {success: true, peerId: this.id};
  }

  sendChat = ({message}) => {
    if (message.length === 0) {
      return {error: true, message: 'can\'t send a blank message'};
    }

    this.currentRoom.sendChat({message, from: this});

    return {success: true};
  }

  vote = ({direction}) => {
    if (!this.currentRoom) {
      return {error: true, message: 'you must be in a room in order to vote'};
    } else if (!this.currentRoom.nowPlaying) {
      return {error: true, message: 'there is no song playing to vote on'};
    }

    return this.currentRoom.setVote({peerId: this.id, direction});
  }

  skipTurn = () => {
    if (!this.currentRoom || !this.currentRoom.activeDj || this.currentRoom.activeDj.id !== this.id) {
      return {error: true, message: 'must be active dj to skip turn'};
    }

    this.currentRoom.endTrack();
    return {success: true};
  }

  updatedQueue = () => {
    if (!this.currentRoom || this.currentRoom.nextDj() !== this) {
      return;
    }

    this.currentRoom.fetchOnDeck();

    return {success: true};
  }

  ////
  // Helpers
  //
  serialize = () => ({
    id: this.id,
    profile: this.profile,
  })

  send = ({name, params = {}}) => {
    return new Promise((resolve) => {
      console.log(`[SND ${this.id.split('-')[0]}]: ${name}`);
      this.socket.emit('call', {name, params}, (...args) => resolve(...args));
    });
  }
}

module.exports = Peer;
