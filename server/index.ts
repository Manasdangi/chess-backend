import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Server } from 'socket.io';
import cors from 'cors';
import { Chess, type Move as ChessMove, type Square } from 'chess.js';

interface Move {
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
  san?: string;
  lan?: string;
  fen?: string;
}

interface ClockState {
  whiteTime: number;
  blackTime: number;
}

interface CaptureState {
  whiteScore: number[];
  blackScore: number[];
}

interface GameStatus {
  isCheck: boolean;
  isCheckmate: boolean;
  isDraw: boolean;
  isGameOver: boolean;
  winner: 'white' | 'black' | 'draw' | null;
  endReason?: string;
}

interface ServerMovePayload extends ClockState, CaptureState {
  fen: string;
  move: Move;
  status: GameStatus;
}

interface RoomGame {
  game: Chess;
  whiteTime: number;
  blackTime: number;
  lastTickAt: number;
  timer: ReturnType<typeof setInterval> | null;
  socketColors: Map<string, 'white' | 'black'>;
  whiteScore: number[];
  blackScore: number[];
  over: boolean;
}

interface ViewerCountStore {
  count: number;
  viewerIds: string[];
}

const PORT = process.env.PORT || 3001;
const GAME_SECONDS = 10 * 60;
const VIEWER_COUNT_FILE =
  process.env.VIEWER_COUNT_FILE || path.join(process.cwd(), 'data', 'viewer-count.json');
const PIECE_TO_CODE = {
  k: 1,
  q: 2,
  b: 3,
  n: 4,
  r: 5,
  p: 6,
} as const;

function resolveCorsOrigin(): string | string[] {
  const fromEnv = process.env.CORS_ORIGINS?.split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (fromEnv?.length) {
    return fromEnv.length === 1 ? fromEnv[0]! : fromEnv;
  }
  return process.env.NODE_ENV === 'production'
    ? 'https://chess-gamma-five.vercel.app'
    : [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        'http://localhost:5176',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:5174',
        'http://127.0.0.1:5175',
        'http://127.0.0.1:5176',
      ];
}

const corsOrigin = resolveCorsOrigin();

const app = express();
const server = createServer(app);

app.use(express.json());

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
const roomGames = new Map<string, RoomGame>();
let viewerStoreWriteQueue = Promise.resolve();

type JoinProfile = { email: string; displayName?: string };

function isViewerCountStore(value: unknown): value is ViewerCountStore {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<ViewerCountStore>;
  return typeof data.count === 'number' && Array.isArray(data.viewerIds);
}

async function readViewerCountStore(): Promise<ViewerCountStore> {
  try {
    const file = await fs.readFile(VIEWER_COUNT_FILE, 'utf8');
    const parsed: unknown = JSON.parse(file);
    if (isViewerCountStore(parsed)) {
      return {
        count: Math.max(0, Math.floor(parsed.count)),
        viewerIds: parsed.viewerIds.filter(id => typeof id === 'string'),
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Could not read viewer count store', error);
    }
  }

  return { count: 0, viewerIds: [] };
}

async function writeViewerCountStore(store: ViewerCountStore) {
  await fs.mkdir(path.dirname(VIEWER_COUNT_FILE), { recursive: true });
  await fs.writeFile(VIEWER_COUNT_FILE, JSON.stringify(store, null, 2));
}

async function registerViewer(visitorId: string) {
  viewerStoreWriteQueue = viewerStoreWriteQueue.then(async () => {
    const store = await readViewerCountStore();
    if (!store.viewerIds.includes(visitorId)) {
      store.viewerIds.push(visitorId);
      store.count = store.viewerIds.length;
      await writeViewerCountStore(store);
    }
    return undefined;
  });

  await viewerStoreWriteQueue;
  return readViewerCountStore();
}

function oppositeColor(color: 'white' | 'black') {
  return color === 'white' ? 'black' : 'white';
}

function turnName(game: Chess): 'white' | 'black' {
  return game.turn() === 'w' ? 'white' : 'black';
}

function getRoomGame(roomId: string): RoomGame {
  const existing = roomGames.get(roomId);
  if (existing) return existing;
  const next: RoomGame = {
    game: new Chess(),
    whiteTime: GAME_SECONDS,
    blackTime: GAME_SECONDS,
    lastTickAt: Date.now(),
    timer: null,
    socketColors: new Map(),
    whiteScore: [],
    blackScore: [],
    over: false,
  };
  roomGames.set(roomId, next);
  return next;
}

function stopRoomTimer(roomId: string) {
  const roomGame = roomGames.get(roomId);
  if (!roomGame?.timer) return;
  clearInterval(roomGame.timer);
  roomGame.timer = null;
}

function statusForGame(game: Chess, endReason?: string): GameStatus {
  const isCheckmate = game.isCheckmate();
  const isDraw = game.isDraw();
  const isGameOver = game.isGameOver();
  const winner = isCheckmate ? oppositeColor(turnName(game)) : isDraw ? 'draw' : null;

  let resolvedReason = endReason;
  if (!resolvedReason && isCheckmate) resolvedReason = 'checkmate';
  if (!resolvedReason && game.isStalemate()) resolvedReason = 'stalemate';
  if (!resolvedReason && game.isThreefoldRepetition()) resolvedReason = 'threefold_repetition';
  if (!resolvedReason && game.isInsufficientMaterial()) resolvedReason = 'insufficient_material';
  if (!resolvedReason && game.isDrawByFiftyMoves()) resolvedReason = 'fifty_move_rule';
  if (!resolvedReason && isDraw) resolvedReason = 'draw';

  return {
    isCheck: game.isCheck(),
    isCheckmate,
    isDraw,
    isGameOver,
    winner,
    endReason: resolvedReason,
  };
}

function gameOverPayload(
  roomGame: RoomGame,
  status: GameStatus,
  winner: 'white' | 'black' | 'draw' | null = status.winner
) {
  return {
    fen: roomGame.game.fen(),
    whiteTime: roomGame.whiteTime,
    blackTime: roomGame.blackTime,
    whiteScore: roomGame.whiteScore,
    blackScore: roomGame.blackScore,
    ...status,
    winner,
  };
}

function movePayload(roomGame: RoomGame, move: ChessMove, status: GameStatus): ServerMovePayload {
  return {
    fen: roomGame.game.fen(),
    whiteTime: roomGame.whiteTime,
    blackTime: roomGame.blackTime,
    whiteScore: roomGame.whiteScore,
    blackScore: roomGame.blackScore,
    move: {
      from: move.from,
      to: move.to,
      promotion: move.promotion as Move['promotion'],
      san: move.san,
      lan: move.lan,
      fen: roomGame.game.fen(),
    },
    status,
  };
}

function trackCapture(roomGame: RoomGame, move: ChessMove) {
  if (!move.captured) return;
  const capturedColor = move.color === 'w' ? 'b' : 'w';
  const capturedCode = PIECE_TO_CODE[move.captured] * (capturedColor === 'w' ? 1 : -1);
  if (move.color === 'w') {
    roomGame.whiteScore.push(capturedCode);
  } else {
    roomGame.blackScore.push(capturedCode);
  }
}

function syncClock(roomId: string) {
  const roomGame = roomGames.get(roomId);
  if (!roomGame || roomGame.over) return null;

  const now = Date.now();
  const elapsed = Math.floor((now - roomGame.lastTickAt) / 1000);
  if (elapsed < 1) return null;

  if (turnName(roomGame.game) === 'white') {
    roomGame.whiteTime = Math.max(0, roomGame.whiteTime - elapsed);
  } else {
    roomGame.blackTime = Math.max(0, roomGame.blackTime - elapsed);
  }
  roomGame.lastTickAt += elapsed * 1000;

  if (roomGame.whiteTime === 0 || roomGame.blackTime === 0) {
    roomGame.over = true;
    stopRoomTimer(roomId);
    const winner = roomGame.whiteTime === 0 ? 'black' : 'white';
    const status: GameStatus = {
      isCheck: roomGame.game.isCheck(),
      isCheckmate: false,
      isDraw: false,
      isGameOver: true,
      winner,
      endReason: 'clock_timeout',
    };
    io.to(roomId).emit('gameOver', gameOverPayload(roomGame, status, winner));
    return status;
  }

  io.to(roomId).emit('clockUpdate', {
    whiteTime: roomGame.whiteTime,
    blackTime: roomGame.blackTime,
  });
  return null;
}

function startRoomTimer(roomId: string) {
  const roomGame = getRoomGame(roomId);
  stopRoomTimer(roomId);
  roomGame.lastTickAt = Date.now();
  roomGame.timer = setInterval(() => syncClock(roomId), 1000);
}

function resetRoomGame(roomId: string) {
  stopRoomTimer(roomId);
  const roomGame: RoomGame = {
    game: new Chess(),
    whiteTime: GAME_SECONDS,
    blackTime: GAME_SECONDS,
    lastTickAt: Date.now(),
    timer: null,
    socketColors: new Map(),
    whiteScore: [],
    blackScore: [],
    over: false,
  };
  roomGames.set(roomId, roomGame);
  return roomGame;
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy' });
});

app.get('/viewer-count', async (_req: Request, res: Response) => {
  const store = await readViewerCountStore();
  res.status(200).json({ count: store.count });
});

app.post('/viewer-count/register', async (req: Request, res: Response) => {
  const visitorId = typeof req.body?.visitorId === 'string' ? req.body.visitorId.trim() : '';
  if (!visitorId) {
    res.status(400).json({ message: 'visitorId is required' });
    return;
  }

  const store = await registerViewer(visitorId);
  res.status(200).json({ count: store.count });
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
        : profileOrEmail || { email: '', displayName: '' };
    const userId = profile.email?.trim() || socket.id;
    const displayName = profile.displayName?.trim() || 'Guest Player';

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
    if (color !== 'white' && color !== 'black') {
      socket.emit('moveRejected', { message: 'Invalid color choice.' });
      return;
    }

    const sockets = roomPlayersSocketId.get(roomId) || [];
    if (sockets.length < 2) {
      socket.emit('moveRejected', { message: 'Wait for the opponent before choosing a color.' });
      return;
    }
    if (socket.id !== sockets[0]) {
      socket.emit('moveRejected', { message: 'Only the room creator can choose a color.' });
      return;
    }

    const roomGame = resetRoomGame(roomId);
    roomGame.socketColors.set(sockets[0]!, color);
    roomGame.socketColors.set(sockets[1]!, oppositeColor(color));

    socket.to(roomId).emit('opponentChoosePieceColor', color);
    io.to(roomId).emit('clockUpdate', {
      whiteTime: roomGame.whiteTime,
      blackTime: roomGame.blackTime,
    });
    startRoomTimer(roomId);
  });

  socket.on('updateOpponentScore', (roomId: string, score: number[], color: string) => {
    console.log('updateOpponentScore', roomId, score, color);
    socket.to(roomId).emit('newOpponentScore', score, color);
  });

  socket.on('move', ({ roomId, move }: { roomId: string; move: Move }) => {
    const roomGame = roomGames.get(roomId);
    const playerColor = roomGame?.socketColors.get(socket.id);
    if (!roomGame || !playerColor) {
      socket.emit('moveRejected', { message: 'Game is not ready yet.' });
      return;
    }
    if (roomGame.over) {
      socket.emit('moveRejected', { message: 'This game is already over.' });
      return;
    }

    syncClock(roomId);
    if (roomGame.over) return;

    if (playerColor !== turnName(roomGame.game)) {
      socket.emit('moveRejected', { message: 'It is not your turn.' });
      return;
    }

    let legalMove: ChessMove | null = null;
    try {
      legalMove = roomGame.game.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || 'q',
      });
    } catch {
      legalMove = null;
    }

    if (!legalMove) {
      socket.emit('moveRejected', { message: 'Illegal move rejected by server.' });
      return;
    }

    roomGame.lastTickAt = Date.now();
    trackCapture(roomGame, legalMove);
    const status = statusForGame(roomGame.game);
    if (status.isGameOver) {
      roomGame.over = true;
      stopRoomTimer(roomId);
    }

    const payload = movePayload(roomGame, legalMove, status);
    socket.emit('moveAccepted', payload);
    socket.to(roomId).emit('opponentMove', payload);
    console.log(`🎯 Move in ${roomId}: ${legalMove.san}`);
  });

  socket.on('resign', (roomId: string) => {
    const roomGame = getRoomGame(roomId);
    const playerColor = roomGame.socketColors.get(socket.id);
    roomGame.over = true;
    stopRoomTimer(roomId);
    const winner = playerColor ? oppositeColor(playerColor) : null;
    const status: GameStatus = {
      isCheck: roomGame.game.isCheck(),
      isCheckmate: false,
      isDraw: false,
      isGameOver: true,
      winner,
      endReason: 'resigned',
    };
    io.to(roomId).emit('gameOver', gameOverPayload(roomGame, status, winner));
    console.log(`🤝 Player resigned in room ${roomId}`);
  });

  socket.on('onOpponentTimeout', (roomId: string) => {
    syncClock(roomId);
    console.log(`⏱️ Player timed out in room ${roomId}`);
  });

  socket.on('onOpponentKingKilled', (roomId: string) => {
    console.log(`💬 Legacy king capture event ignored in room ${roomId}`)  
  });

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        const sockets = roomPlayersSocketId.get(room) || [];
        const leavingPlayerIndex = sockets.indexOf(socket.id);
        const nextSockets = sockets.filter(id => id !== socket.id);
        const nextPlayers = (roomPlayers.get(room) || []).filter(
          (_, index) => index !== leavingPlayerIndex
        );
        const nextProfiles = (roomPlayerProfiles.get(room) || []).filter(
          (_, index) => index !== leavingPlayerIndex
        );
        const count = nextSockets.length;

        if (count === 0) {
          stopRoomTimer(room);
          activeRooms.delete(room);
          roomCreators.delete(room);
          roomPlayerCount.delete(room);
          roomPlayers.delete(room);
          roomPlayersSocketId.delete(room);
          roomPlayerProfiles.delete(room);
          roomGames.delete(room);
        } else {
          roomPlayerCount.set(room, count);
          roomPlayers.set(room, nextPlayers);
          roomPlayersSocketId.set(room, nextSockets);
          roomPlayerProfiles.set(room, nextProfiles);
        }
      }
    });
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
