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

function resolveCorsOrigin(): string | string[] {
  const fromEnv = process.env.CORS_ORIGINS?.split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (fromEnv?.length) {
    return fromEnv.length === 1 ? fromEnv[0]! : fromEnv;
  }
  return process.env.NODE_ENV === 'production'
    ? 'https://chess-gamma-five.vercel.app'
    : 'http://localhost:5173';
}

const corsOrigin = resolveCorsOrigin();

const app = express();
const server = createServer(app);

// Express CORS
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);

// Socket.IO CORS
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Room tracking
export const activeRooms = new Set<string>();
const roomCreators = new Map<string, string>();
const roomPlayerCount = new Map<string, number>();
const roomPlayers = new Map<string, string[]>();
const roomPlayersSocketId = new Map<string, string[]>();
const roomPlayerProfiles = new Map<string, { email: string; displayName: string }[]>();

type JoinProfile = { email: string; displayName?: string };

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy' });
});

io.on('connection', socket => {
  console.log(`🔌 Client connected: ${socket.id}`);

  socket.on('checkRoom', (roomId: string, callback: (exists: boolean) => void) => {
    const exists = activeRooms.has(roomId);
    callback(exists);
  });

  socket.on('joinRoom', (roomId: string, profileOrEmail: string | JoinProfile) => {
    const profile: JoinProfile =
      typeof profileOrEmail === 'string'
        ? { email: profileOrEmail, displayName: '' }
        : profileOrEmail;
    const userId = profile.email;
    const displayName = profile.displayName?.trim() ?? '';

    console.log('joinRoom', roomId, socket.id, userId);

    const currentCount = roomPlayerCount.get(roomId) || 0;
    const currentPlayers = roomPlayers.get(roomId) || [];

    // Already in room
    console.log('currentPlayers1', currentPlayers);
    if (currentPlayers.includes(userId)) {
      console.log('already in room');
      socket.emit('alreadyInRoom', {
        message: 'You are already in this room',
        isCreator: currentPlayers[0] === userId,
        playerCount: currentCount,
        userId: socket.id,
      });
      return;
    }

    // Room full (two players already present)
    if (currentCount >= 2) {
      console.log('room is full');
      socket.emit('roomFull', {
        message: 'Room is full. Maximum 2 players allowed.',
        userId: socket.id,
      });
      return;
    }

    socket.join(roomId);
    roomPlayers.set(roomId, [...currentPlayers, userId]);
    roomPlayersSocketId.set(roomId, [...(roomPlayersSocketId.get(roomId) || []), socket.id]);
    roomPlayerProfiles.set(roomId, [
      ...(roomPlayerProfiles.get(roomId) || []),
      { email: userId, displayName },
    ]);
    console.log('currentPlayers2', roomPlayers.get(roomId));
    const newCount = currentCount + 1;
    roomPlayerCount.set(roomId, newCount);

    const isCreator = newCount === 1;
    if (isCreator) {
      roomCreators.set(roomId, userId);
      activeRooms.add(roomId);
    }

    socket.emit('roomJoined', {
      message: isCreator ? 'Room created successfully!' : 'Joined room successfully!',
      isCreator,
      playerCount: newCount,
      userId: socket.id,
    });

    if (newCount === 2) {
      const sockets = roomPlayersSocketId.get(roomId) || [];
      const profiles = roomPlayerProfiles.get(roomId) || [];
      if (sockets.length === 2 && profiles.length === 2) {
        console.log('both players joined');
        io.to(sockets[0]!).emit('opponentJoined', {
          opponentEmail: profiles[1]!.email,
          opponentDisplayName: profiles[1]!.displayName,
        });
        io.to(sockets[1]!).emit('opponentJoined', {
          opponentEmail: profiles[0]!.email,
          opponentDisplayName: profiles[0]!.displayName,
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
    console.log(`⏱️ Player timed out in room ${roomId}`);
  });

  socket.on('onOpponentKingKilled', (roomId: string, email: string) => {
    socket.to(roomId).emit('opponentKingKilled', email);
    console.log(`💬 Message in room ${roomId}: ${email}`)  
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
          roomPlayersSocketId.delete(room);
          roomPlayerProfiles.delete(room);
        }
      }
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
