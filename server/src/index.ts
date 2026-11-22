import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';
import {
  alertPartnerBid,
  applyBid,
  applyPlayCard,
  BidCall,
  Card,
  createNewBoard,
  explainPartnerBid,
  GameState,
  generatePBN,
  initiateClaim,
  requestBidExplanation,
  respondToClaim,
  sanitizeStateForSeat,
  Seat,
} from './bridgeEngine';

const PORT = Number(process.env.PORT || 3001);
const app = express();
app.use(cors());
app.use(express.json());

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

interface SeatSession {
  socketId: string;
  token: string;
  playerName: string;
}

interface TableRoom {
  id: string;
  seats: Partial<Record<Seat, SeatSession>>;
  game: GameState;
}

const rooms = new Map<string, TableRoom>();
const memoryBoards = new Map<string, any[]>();

function getOrCreateRoom(tableId: string): TableRoom {
  let room = rooms.get(tableId);
  if (!room) {
    room = {
      id: tableId,
      seats: {},
      game: createNewBoard(1),
    };
    rooms.set(tableId, room);
  }
  return room;
}

async function persistCompletedBoard(tableId: string, game: GameState) {
  const pbn = generatePBN(game);
  const contractText = game.contract
    ? `${game.contract.level}${game.contract.strain}${
        game.contract.doubled === 1 ? 'X' : game.contract.doubled === 2 ? 'XX' : ''
      }`
    : null;

  const record = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    board_number: game.boardNumber,
    dealer: game.dealer,
    vulnerability: game.vulnerability,
    contract_text: contractText,
    declarer: game.contract?.declarer || null,
    tricks_ns: game.tricksWon.NS,
    tricks_ew: game.tricksWon.EW,
    score_ns: game.score?.NS ?? 0,
    score_ew: game.score?.EW ?? 0,
    pbn,
  };

  const list = memoryBoards.get(tableId) || [];
  list.push(record);
  memoryBoards.set(tableId, list);

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO completed_boards
         (table_id, board_number, dealer, vulnerability, contract_text, declarer, tricks_ns, tricks_ew, score_ns, score_ew, pbn)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          tableId,
          record.board_number,
          record.dealer,
          record.vulnerability,
          record.contract_text,
          record.declarer,
          record.tricks_ns,
          record.tricks_ew,
          record.score_ns,
          record.score_ew,
          record.pbn,
        ]
      );
    } catch {
      // Fallback to in-memory store
    }
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/boards/:tableId', async (req, res) => {
  const { tableId } = req.params;
  if (pool) {
    try {
      const result = await pool.query(
        'SELECT * FROM completed_boards WHERE table_id = $1 ORDER BY id ASC',
        [tableId]
      );
      return res.json({ boards: result.rows });
    } catch {
      // Fallback to in-memory store
    }
  }
  return res.json({ boards: memoryBoards.get(tableId) || [] });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

function getSeatNames(room: TableRoom): Partial<Record<Seat, string>> {
  const names: Partial<Record<Seat, string>> = {};
  for (const s of ['N', 'E', 'S', 'W'] as Seat[]) {
    if (room.seats[s]?.playerName) {
      names[s] = room.seats[s]!.playerName;
    }
  }
  return names;
}

function broadcastRoomState(room: TableRoom) {
  const allSockets = io.sockets.adapter.rooms.get(room.id);
  if (!allSockets) return;
  const seatNames = getSeatNames(room);
  for (const sid of allSockets) {
    let viewerSeat: Seat | null = null;
    for (const s of ['N', 'E', 'S', 'W'] as Seat[]) {
      if (room.seats[s]?.socketId === sid) {
        viewerSeat = s;
        break;
      }
    }
    io.to(sid).emit('table_state', {
      mySeat: viewerSeat,
      playerName: viewerSeat ? room.seats[viewerSeat]?.playerName : undefined,
      seatNames,
      game: sanitizeStateForSeat(room.game, viewerSeat),
    });
  }
}

io.on('connection', (socket) => {
  socket.on(
    'join_table',
    ({
      tableId,
      seat,
      playerName,
      reconnectToken,
    }: {
      tableId: string;
      seat: Seat;
      playerName?: string;
      reconnectToken?: string;
    }) => {
      const room = getOrCreateRoom(tableId);
      socket.join(tableId);

      const existing = room.seats[seat];
      if (existing && existing.socketId !== socket.id) {
        const oldSocketActive = io.sockets.sockets.has(existing.socketId);
        if (oldSocketActive && existing.token !== reconnectToken) {
          socket.emit('error_msg', `Seat ${seat} is already occupied in room ${tableId}.`);
          return;
        }
      }

      const token = reconnectToken || uuidv4();
      const trimmedName =
        typeof playerName === 'string' && playerName.trim().length > 0
          ? playerName.trim()
          : existing?.playerName || `Player ${seat}`;

      room.seats[seat] = { socketId: socket.id, token, playerName: trimmedName };

      socket.emit('table_state', {
        mySeat: seat,
        playerName: trimmedName,
        seatNames: getSeatNames(room),
        reconnectToken: token,
        game: sanitizeStateForSeat(room.game, seat),
      });
      broadcastRoomState(room);
    }
  );

  socket.on('make_bid', async ({ tableId, call }: { tableId: string; call: BidCall }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    const seat = (['N', 'E', 'S', 'W'] as Seat[]).find((s) => room.seats[s]?.socketId === socket.id);
    if (!seat) {
      socket.emit('error_msg', 'Sit at a seat before bidding.');
      return;
    }
    const result = applyBid(room.game, seat, call);
    if (!result.ok) {
      socket.emit('error_msg', result.error || 'Illegal bid.');
      return;
    }
    if (room.game.phase === 'FINISHED') {
      await persistCompletedBoard(tableId, room.game);
    }
    broadcastRoomState(room);
  });

  socket.on(
    'alert_bid',
    ({ tableId, bidIndex, explanation }: { tableId: string; bidIndex: number; explanation?: string }) => {
      const room = rooms.get(tableId);
      if (!room) return;
      const seat = (['N', 'E', 'S', 'W'] as Seat[]).find((s) => room.seats[s]?.socketId === socket.id);
      if (!seat) {
        socket.emit('error_msg', 'Sit at a seat before alerting.');
        return;
      }
      const result = alertPartnerBid(room.game, seat, bidIndex, explanation);
      if (!result.ok) {
        socket.emit('error_msg', result.error || 'Unable to alert bid.');
        return;
      }
      broadcastRoomState(room);
    }
  );

  socket.on('request_explanation', ({ tableId, bidIndex }: { tableId: string; bidIndex: number }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    const seat = (['N', 'E', 'S', 'W'] as Seat[]).find((s) => room.seats[s]?.socketId === socket.id);
    if (!seat) {
      socket.emit('error_msg', 'Sit at a seat before asking for an explanation.');
      return;
    }
    const result = requestBidExplanation(room.game, seat, bidIndex);
    if (!result.ok) {
      socket.emit('error_msg', result.error || 'Unable to request explanation.');
      return;
    }
    broadcastRoomState(room);
  });

  socket.on(
    'explain_bid',
    ({ tableId, bidIndex, explanation }: { tableId: string; bidIndex: number; explanation: string }) => {
      const room = rooms.get(tableId);
      if (!room) return;
      const seat = (['N', 'E', 'S', 'W'] as Seat[]).find((s) => room.seats[s]?.socketId === socket.id);
      if (!seat) {
        socket.emit('error_msg', 'Sit at a seat before explaining a bid.');
        return;
      }
      const result = explainPartnerBid(room.game, seat, bidIndex, explanation);
      if (!result.ok) {
        socket.emit('error_msg', result.error || 'Unable to submit explanation.');
        return;
      }
      broadcastRoomState(room);
    }
  );

  socket.on('play_card', async ({ tableId, card }: { tableId: string; card: Card }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    const seat = (['N', 'E', 'S', 'W'] as Seat[]).find((s) => room.seats[s]?.socketId === socket.id);
    if (!seat) {
      socket.emit('error_msg', 'Sit at a seat before playing cards.');
      return;
    }
    const result = applyPlayCard(room.game, seat, card);
    if (!result.ok) {
      socket.emit('error_msg', result.error || 'Illegal play.');
      return;
    }
    if (room.game.phase === 'FINISHED') {
      await persistCompletedBoard(tableId, room.game);
    }
    broadcastRoomState(room);
  });

  socket.on('claim_tricks', ({ tableId, claimedTricks }: { tableId: string; claimedTricks: number }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    const seat = (['N', 'E', 'S', 'W'] as Seat[]).find((s) => room.seats[s]?.socketId === socket.id);
    if (!seat) {
      socket.emit('error_msg', 'Sit at a seat before claiming.');
      return;
    }
    const result = initiateClaim(room.game, seat, claimedTricks);
    if (!result.ok) {
      socket.emit('error_msg', result.error || 'Invalid claim.');
      return;
    }
    broadcastRoomState(room);
  });

  socket.on('respond_claim', async ({ tableId, accept }: { tableId: string; accept: boolean }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    const seat = (['N', 'E', 'S', 'W'] as Seat[]).find((s) => room.seats[s]?.socketId === socket.id);
    if (!seat) {
      socket.emit('error_msg', 'Sit at a seat before responding to a claim.');
      return;
    }
    const result = respondToClaim(room.game, seat, accept);
    if (!result.ok) {
      socket.emit('error_msg', result.error || 'Unable to respond to claim.');
      return;
    }
    if (room.game.phase === 'FINISHED') {
      await persistCompletedBoard(tableId, room.game);
    }
    broadcastRoomState(room);
  });

  socket.on('next_board', ({ tableId }: { tableId: string }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    room.game = createNewBoard(room.game.boardNumber + 1);
    broadcastRoomState(room);
  });
});

server.listen(PORT, () => {
  console.log(`Contract Bridge server running on port ${PORT}`);
});
