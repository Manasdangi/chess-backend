import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

 interface Move {
    from: {
      row: number;
      col: number;
    };
    to: {
      row: number;
      col: number;
    };
    piece: number;
  }
  

const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.NODE_ENV === 'production' 
  ? "https://chess-gamma-five.vercel.app" // production URL
  : "http://localhost:5173"; // local dev URL

// Setup express app
const app = express();

// Create HTTP server from express app
const server = createServer(app);

// Express CORS
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

// Socket.IO CORS
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Store active room IDs and their creators
export const activeRooms = new Set<string>();
const roomCreators = new Map<string, string>();
const roomPlayerCount = new Map<string, number>();
const roomPlayers = new Map<string, string[]>();

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy' });
});

io.on('connection', socket => {
  console.log(`🔌 Client connected: ${socket.id}`);

  //
  socket.on('checkRoom', (roomId: string, callback: (exists: boolean) => void) => {
    const exists = activeRooms.has(roomId);
    if (!exists) {
      console.log('room does not exist');
      callback(false);
    } else {
      console.log('room exists');
      callback(true);
    }
  });

  // Join a room
  socket.on('joinRoom', (roomId: string, userId: string) => {
    console.log('joinRoom', roomId, userId);

    const currentCount = roomPlayerCount.get(roomId) || 0;
    const currentPlayers = roomPlayers.get(roomId) || [];
    console.log('currentCount', currentCount);

    // Handle room full case
    if (currentCount > 2) {
      console.log('room is full');
      socket.emit('roomFull', {
        message: 'Room is full. Maximum 2 players allowed.',
        userId: socket.id,
      });
      return;
    }

    // Handle already in room case
    if (currentPlayers.includes(socket.id)) {
      socket.emit('alreadyInRoom', {
        message: 'You are already in this room',
        isCreator: currentPlayers[0] === socket.id,
        playerCount: currentCount,
        userId: socket.id,
      });
      return;
    }

    socket.join(roomId);
    roomPlayers.set(roomId, [...currentPlayers, socket.id]);
    const newCount = currentCount + 1;
    roomPlayerCount.set(roomId, newCount);

    const isCreator = newCount === 1;
    if (isCreator) {
      roomCreators.set(roomId, socket.id);
      activeRooms.add(roomId);
    }

    // Notify the joining player
    socket.emit('roomJoined', {
      message: isCreator ? 'Room created successfully!' : 'Joined room successfully!',
      isCreator,
      playerCount: newCount,
      userId: socket.id,
    });

    // If second player joined, notify the first player
    if (newCount === 2) {
      const firstPlayerId = currentPlayers[0];
      if (firstPlayerId) {
        io.to(firstPlayerId).emit('opponentJoined', {
          message: 'Your opponent has joined the room!',
          playerCount: newCount,
          userId: firstPlayerId,
        });
      }
    }
  });

  socket.on('choosePieceColor', (roomId: string, color: string) => {
    socket.to(roomId).emit('opponentChoosePieceColor', color);
  });

  socket.on('updateOpponentScore', (roomId: string, score: number[], color: string) => {
    console.log('updateOpponentScore', roomId, score, color);
    socket.to(roomId).emit('newOpponentScore', score, color);
  });

  // Handle moves and send to opponent
  socket.on('move', ({ roomId, move }: { roomId: string; move: Move }) => {
    socket.to(roomId).emit('opponentMove', move);
    console.log(
      `🎯 Move in ${roomId} by ${move.piece > 0 ? 'white' : 'black'}: ${move.from} → ${move.to}`
    );
  });

  socket.on('resign', (roomId: string, email: string) => {
    socket.to(roomId).emit('opponentResign', email);
    console.log(`🤝 Player resigned in room ${roomId}`);
  });

  socket.on('onOpponentTimeout', (roomId: string, email: string) => {
    socket.to(roomId).emit('opponentTimeout', email);
    console.log(`🤝 Player timedout in room ${roomId}`)
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        const count = (roomPlayerCount.get(room) || 1) - 1;
        roomPlayerCount.set(room, count);
        if (count === 0) {
          activeRooms.delete(room);
          roomCreators.delete(room);
          roomPlayerCount.delete(room);
          roomPlayers.delete(room);
        }
      }
    });
  });
});

// Start the server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
