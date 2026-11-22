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
import {
  addBotSeat,
  clearBotTimer,
  fillOpenSeatsWithBots,
  registerBotSocketHandlers,
  removeBotSeat,
  scheduleBotTurn,
  type BridgeRoom,
} from './botServer';

const PORT = Number(process.env.PORT || 3001);
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

async function ensureBoardHistoryColumns() {
  if (!pool) return;
  try {
    await pool.query(`
      ALTER TABLE completed_boards
      ADD COLUMN IF NOT EXISTS tricks_history JSONB,
      ADD COLUMN IF NOT EXISTS initial_hands JSONB,
      ADD COLUMN IF NOT EXISTS auction JSONB,
      ADD COLUMN IF NOT EXISTS accepted_claim JSONB
    `);
  } catch {
    // Table may not exist yet or user may lack ALTER privileges; handled gracefully on insert/select
  }
}

interface SeatSession {
  socketId: string;
  token: string;
  playerName: string;
}

export interface ChatMessage {
  id: string;
  seat: Seat | 'SPECTATOR';
  senderName: string;
  text: string;
  timestamp: number;
}

interface TableRoom extends BridgeRoom {
  id: string;
  password?: string;
  seats: Partial<Record<Seat, SeatSession>>;
  game: GameState;
  botSeats: Set<Seat>;
  botTimer?: ReturnType<typeof setTimeout> | null;
  chatMessages: ChatMessage[];
}

const rooms = new Map<string, TableRoom>();
const memoryBoards = new Map<string, any[]>();
const ALL_SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const SEAT_FULL_NAME: Record<Seat, string> = {
  N: 'North',
  E: 'East',
  S: 'South',
  W: 'West',
};

function getSeatNames(room: TableRoom): Partial<Record<Seat, string>> {
  const names: Partial<Record<Seat, string>> = {};
  for (const s of ALL_SEATS) {
    if (room.botSeats?.has(s)) {
      names[s] = room.seats[s]?.playerName || `Bot ${SEAT_FULL_NAME[s]}`;
    } else if (room.seats[s]?.playerName) {
      names[s] = room.seats[s]!.playerName;
    }
  }
  return names;
}

function broadcastRoomState(room: TableRoom) {
  const allSockets = io.sockets.adapter.rooms.get(room.id);
  if (!allSockets) return;
  const seatNames = getSeatNames(room);
  const botSeatsList = Array.from(room.botSeats || []);
  for (const sid of allSockets) {
    let viewerSeat: Seat | null = null;
    for (const s of ALL_SEATS) {
      if (room.seats[s]?.socketId === sid) {
        viewerSeat = s;
        break;
      }
    }
    io.to(sid).emit('table_state', {
      tableId: room.id,
      mySeat: viewerSeat,
      playerName: viewerSeat ? room.seats[viewerSeat]?.playerName : undefined,
      seatNames,
      botSeats: botSeatsList,
      chatMessages: room.chatMessages,
      game: sanitizeStateForSeat(room.game, viewerSeat),
    });
  }
}

function buildRoomsList() {
  return Array.from(rooms.entries()).map(([id, room]) => {
    const seats: Partial<Record<Seat, string>> = {};
    let occupiedCount = 0;
    for (const s of ALL_SEATS) {
      if (room.botSeats?.has(s)) {
        seats[s] = room.seats[s]?.playerName || `Bot ${SEAT_FULL_NAME[s]}`;
        occupiedCount += 1;
      } else if (room.seats[s]?.playerName) {
        seats[s] = room.seats[s]!.playerName;
        occupiedCount += 1;
      }
    }
    return {
      id,
      hasPassword: Boolean(room.password),
      boardNumber: room.game.boardNumber,
      phase: room.game.phase,
      occupiedCount,
      seats,
      botSeats: Array.from(room.botSeats || []),
    };
  });
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
    tricks_history: game.tricksHistory,
    initial_hands: game.initialHands,
    auction: game.auction,
    accepted_claim: game.acceptedClaim ?? null,
    pbn,
  };

  const list = memoryBoards.get(tableId) || [];
  list.push(record);
  memoryBoards.set(tableId, list);

  if (pool) {
    try {
      await pool.query(
        `INSERT INTO completed_boards
         (table_id, board_number, dealer, vulnerability, contract_text, declarer, tricks_ns, tricks_ew, score_ns, score_ew, tricks_history, initial_hands, auction, accepted_claim, pbn)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15)`,
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
          JSON.stringify(record.tricks_history ?? []),
          JSON.stringify(record.initial_hands ?? {}),
          JSON.stringify(record.auction ?? []),
          record.accepted_claim ? JSON.stringify(record.accepted_claim) : null,
          record.pbn,
        ]
      );
    } catch {
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
}

function syncRoomSeatNamesFromSessions(room: TableRoom) {
  for (const s of ALL_SEATS) {
    if (room.botSeats.has(s)) {
      room.seatNames[s] = room.seats[s]?.playerName || `Bot ${SEAT_FULL_NAME[s]}`;
    } else if (room.seats[s]?.playerName) {
      room.seatNames[s] = room.seats[s]!.playerName;
    } else {
      delete room.seatNames[s];
    }
  }
}

function getOrCreateRoom(tableId: string, password?: string): TableRoom {
  let room = rooms.get(tableId);
  if (!room) {
    const cleanPw =
      typeof password === 'string' && password.trim().length > 0
        ? password.trim()
        : undefined;
    const created: TableRoom = {
      id: tableId,
      password: cleanPw,
      seats: {},
      game: createNewBoard(1),
      botSeats: new Set<Seat>(),
      botTimer: null,
      chatMessages: [],
      seatNames: {},
      applyBid: (targetRoom, seat, call) => {
        const r = targetRoom as TableRoom;
        const res = applyBid(r.game, seat, call);
        if (res.ok && r.game.phase === 'FINISHED') {
          void persistCompletedBoard(r.id, r.game);
        }
        return res;
      },
      applyPlayCard: (targetRoom, seat, card) => {
        const r = targetRoom as TableRoom;
        const res = applyPlayCard(r.game, seat, card);
        if (res.ok && r.game.phase === 'FINISHED') {
          void persistCompletedBoard(r.id, r.game);
        }
        return res;
      },
      applyRespondClaim: (targetRoom, seat, accept) => {
        const r = targetRoom as TableRoom;
        const res = respondToClaim(r.game, seat, accept);
        if (res.ok && r.game.phase === 'FINISHED') {
          void persistCompletedBoard(r.id, r.game);
        }
        return res;
      },
      broadcastTableState: (targetRoom) => {
        broadcastRoomState(targetRoom as TableRoom);
      },
      broadcastRoomsList: () => {
        io.emit('rooms_updated', buildRoomsList());
      },
    };
    room = created;
    rooms.set(tableId, room);
  }
  syncRoomSeatNamesFromSessions(room);
  return room;
}

function getOccupiedCount(room: TableRoom): number {
  let count = 0;
  for (const s of ALL_SEATS) {
    if (room.botSeats?.has(s) || room.seats[s]?.playerName) {
      count += 1;
    }
  }
  return count;
}

function cleanupEmptyRooms(): string[] {
  const removed: string[] = [];
  for (const [roomId, room] of Array.from(rooms.entries())) {
    const connectedInRoom = io.sockets.adapter.rooms.get(roomId)?.size ?? 0;
    if (getOccupiedCount(room) === 0 && connectedInRoom === 0) {
      clearBotTimer(room);
      rooms.delete(roomId);
      removed.push(roomId);
    }
  }
  return removed;
}

function removeSeatFromRoom(room: TableRoom, seat: Seat) {
  if (room.botSeats.has(seat)) {
    removeBotSeat(room, seat);
    delete room.seats[seat];
    syncRoomSeatNamesFromSessions(room);
    broadcastRoomState(room);
    io.emit('rooms_updated', buildRoomsList());
    scheduleBotTurn(room);
    return;
  }

  const session = room.seats[seat];
  if (!session) return;

  const targetSocket = io.sockets.sockets.get(session.socketId);
  if (targetSocket) {
    targetSocket.leave(room.id);
    targetSocket.emit('removed_from_room', {
      tableId: room.id,
      seat,
      reason: 'You were removed from the table.',
    });
    targetSocket.emit('left_table');
  }

  delete room.seats[seat];
  syncRoomSeatNamesFromSessions(room);
  broadcastRoomState(room);
  io.emit('rooms_updated', buildRoomsList());
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/rooms', (_req, res) => {
  res.json({ rooms: buildRoomsList() });
});

app.post('/api/rooms/cleanup', (_req, res) => {
  const removed = cleanupEmptyRooms();
  const updatedList = buildRoomsList();
  io.emit('rooms_updated', updatedList);
  res.json({ removed, rooms: updatedList });
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

io.on('connection', (socket) => {
  registerBotSocketHandlers(
    io,
    socket,
    (tableId) => rooms.get(tableId),
    (mutatedRoom) => {
      const r = mutatedRoom as TableRoom;
      for (const s of ALL_SEATS) {
        if (r.botSeats.has(s) && !r.seats[s]) {
          r.seats[s] = {
            socketId: `bot-${s}`,
            token: `bot-${s}`,
            playerName: r.seatNames[s] || `Bot ${SEAT_FULL_NAME[s]}`,
          };
        }
      }
      syncRoomSeatNamesFromSessions(r);
    }
  );

  socket.on(
    'join_table',
    ({
      tableId,
      seat,
      playerName,
      password,
      reconnectToken,
      fillBots,
    }: {
      tableId: string;
      seat: Seat;
      playerName?: string;
      password?: string;
      reconnectToken?: string;
      fillBots?: boolean;
    }) => {
      const cleanTableId = (tableId || 'main-room').trim() || 'main-room';
      const existingRoom = rooms.get(cleanTableId);
      const existing = existingRoom?.seats[seat];
      const isValidReconnect = Boolean(
        existing && reconnectToken && existing.token === reconnectToken
      );

      if (existingRoom && existingRoom.password && !isValidReconnect) {
        const supplied = typeof password === 'string' ? password.trim() : '';
        if (supplied !== existingRoom.password) {
          socket.emit('error_msg', `Incorrect password for room "${cleanTableId}".`);
          return;
        }
      }

      if (existing && !existingRoom?.botSeats.has(seat) && existing.socketId !== socket.id) {
        const oldSocketActive = io.sockets.sockets.has(existing.socketId);
        if (oldSocketActive && existing.token !== reconnectToken) {
          socket.emit('error_msg', `Seat ${seat} is already occupied in room ${cleanTableId}.`);
          return;
        }
      }

      for (const joinedRoom of socket.rooms) {
        if (joinedRoom !== socket.id && joinedRoom !== cleanTableId) {
          socket.leave(joinedRoom);
          const prevRoom = rooms.get(joinedRoom);
          if (prevRoom) {
            for (const s of ALL_SEATS) {
              if (prevRoom.seats[s]?.socketId === socket.id) {
                delete prevRoom.seats[s];
              }
            }
            syncRoomSeatNamesFromSessions(prevRoom);
            broadcastRoomState(prevRoom);
          }
        }
      }

      const room = getOrCreateRoom(cleanTableId, password);
      socket.join(cleanTableId);

      if (room.botSeats.has(seat)) {
        room.botSeats.delete(seat);
      }

      const token = reconnectToken || uuidv4();
      const trimmedName =
        typeof playerName === 'string' && playerName.trim().length > 0
          ? playerName.trim()
          : existing?.playerName || `Player ${seat}`;

      room.seats[seat] = { socketId: socket.id, token, playerName: trimmedName };

      if (fillBots) {
        const openSeats = ALL_SEATS.filter(
          (s) => s !== seat && !room.seats[s]?.playerName && !room.botSeats.has(s)
        );
        fillOpenSeatsWithBots(room, openSeats);
        for (const s of openSeats) {
          if (room.botSeats.has(s) && !room.seats[s]) {
            room.seats[s] = {
              socketId: `bot-${s}`,
              token: `bot-${s}`,
              playerName: room.seatNames[s] || `Bot ${SEAT_FULL_NAME[s]}`,
            };
          }
        }
      }

      syncRoomSeatNamesFromSessions(room);

      socket.emit('table_state', {
        tableId: cleanTableId,
        mySeat: seat,
        playerName: trimmedName,
        seatNames: getSeatNames(room),
        botSeats: Array.from(room.botSeats),
        chatMessages: room.chatMessages,
        reconnectToken: token,
        game: sanitizeStateForSeat(room.game, seat),
      });
      broadcastRoomState(room);
      io.emit('rooms_updated', buildRoomsList());
      scheduleBotTurn(room);
    }
  );

  socket.on('kick_seat', ({ tableId, seat }: { tableId: string; seat: Seat }) => {
    const cleanTableId = (tableId || '').trim();
    if (!cleanTableId || !ALL_SEATS.includes(seat)) return;
    const room = rooms.get(cleanTableId);
    if (!room) return;
    removeSeatFromRoom(room, seat);
  });

  socket.on('vacate_seat', ({ tableId, seat }: { tableId: string; seat: Seat }) => {
    const cleanTableId = (tableId || '').trim();
    if (!cleanTableId || !ALL_SEATS.includes(seat)) return;
    const room = rooms.get(cleanTableId);
    if (!room) return;
    removeSeatFromRoom(room, seat);
  });

  socket.on('make_bid', async ({ tableId, call }: { tableId: string; call: BidCall }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    const seat = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
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
    scheduleBotTurn(room);
  });

  socket.on(
    'alert_bid',
    ({
      tableId,
      bidIndex,
      explanation,
    }: {
      tableId: string;
      bidIndex: number;
      explanation?: string;
    }) => {
      const room = rooms.get(tableId);
      if (!room) return;
      const seat = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
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
    const seat = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
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
    ({
      tableId,
      bidIndex,
      explanation,
    }: {
      tableId: string;
      bidIndex: number;
      explanation: string;
    }) => {
      const room = rooms.get(tableId);
      if (!room) return;
      const seat = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
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

  socket.on(
    'play_card',
    async ({
      tableId,
      card,
      seat: requestedSeat,
    }: {
      tableId: string;
      card: Card;
      seat?: Seat;
    }) => {
      const room = rooms.get(tableId);
      if (!room) return;
      const seatedPlayer = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
      if (!seatedPlayer) {
        socket.emit('error_msg', 'Sit at a seat before playing cards.');
        return;
      }

      const isDeclarerPlayingDummy =
        room.game.phase === 'PLAYING' &&
        room.game.currentTurn === room.game.dummy &&
        room.game.contract?.declarer === seatedPlayer &&
        (!requestedSeat || requestedSeat === room.game.dummy);

      const actingSeat: Seat = isDeclarerPlayingDummy
        ? room.game.currentTurn
        : requestedSeat && requestedSeat === seatedPlayer
        ? requestedSeat
        : seatedPlayer;

      const result = applyPlayCard(room.game, actingSeat, card);
      if (!result.ok) {
        socket.emit('error_msg', result.error || 'Illegal play.');
        return;
      }
      if (room.game.phase === 'FINISHED') {
        await persistCompletedBoard(tableId, room.game);
      }
      broadcastRoomState(room);
      scheduleBotTurn(room);
    }
  );

  socket.on(
    'claim_tricks',
    ({ tableId, claimedTricks }: { tableId: string; claimedTricks: number }) => {
      const room = rooms.get(tableId);
      if (!room) return;
      const seat = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
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
      scheduleBotTurn(room);
    }
  );

  socket.on('respond_claim', async ({ tableId, accept }: { tableId: string; accept: boolean }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    const seat = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
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
    scheduleBotTurn(room);
  });

  socket.on('send_chat', ({ tableId, text }: { tableId: string; text: string }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    if (typeof text !== 'string') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const clipped = trimmed.slice(0, 400);

    const seat = ALL_SEATS.find((s) => room.seats[s]?.socketId === socket.id);
    if (!seat) {
      socket.emit('error_msg', 'Sit at a seat to send chat messages.');
      return;
    }

    const msg: ChatMessage = {
      id: uuidv4(),
      seat,
      senderName: room.seats[seat]?.playerName || `Player ${seat}`,
      text: clipped,
      timestamp: Date.now(),
    };

    room.chatMessages.push(msg);
    if (room.chatMessages.length > 150) {
      room.chatMessages.splice(0, room.chatMessages.length - 150);
    }

    io.to(tableId).emit('chat_message', msg);
  });

  socket.on('next_board', ({ tableId }: { tableId: string }) => {
    const room = rooms.get(tableId);
    if (!room) return;
    room.game = createNewBoard(room.game.boardNumber + 1);
    broadcastRoomState(room);
    scheduleBotTurn(room);
  });

  socket.on('leave_table', ({ tableId }: { tableId?: string }) => {
    const roomsToLeave = new Set<string>();
    if (tableId && typeof tableId === 'string') {
      roomsToLeave.add(tableId);
    }
    for (const joinedRoom of socket.rooms) {
      if (joinedRoom !== socket.id) {
        roomsToLeave.add(joinedRoom);
      }
    }

    for (const roomId of roomsToLeave) {
      socket.leave(roomId);
      const room = rooms.get(roomId);
      if (room) {
        for (const s of ALL_SEATS) {
          if (room.seats[s]?.socketId === socket.id) {
            delete room.seats[s];
          }
        }
        syncRoomSeatNamesFromSessions(room);
        broadcastRoomState(room);
      }
    }

    socket.emit('left_table');
    io.emit('rooms_updated', buildRoomsList());
  });

  socket.on('cleanup_empty_rooms', () => {
    const removed = cleanupEmptyRooms();
    const updatedList = buildRoomsList();
    io.emit('rooms_updated', updatedList);
    socket.emit('empty_rooms_cleaned', { removed });
  });

  socket.on('disconnect', () => {
    io.emit('rooms_updated', buildRoomsList());
  });
});

ensureBoardHistoryColumns().finally(() => {
  server.listen(PORT, () => {
    console.log(`Contract Bridge server running on port ${PORT}`);
  });
});
