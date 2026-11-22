import type { Server, Socket } from 'socket.io';
import {
  getNextBotAction,
  type AuctionEntry,
  type BidCall,
  type BotGameState,
  type Card,
  type ClaimState,
  type Seat,
  type Strain,
  type Suit,
} from './bridgeBot';

export interface RoomGameState extends BotGameState {
  initialHands?: Partial<Record<Seat, Card[]>>;
  score?: { NS: number; EW: number } | null;
  acceptedClaim?: unknown;
}

export interface BridgeRoom {
  id: string;
  password?: string;
  game: RoomGameState;
  seatNames: Partial<Record<Seat, string>>;
  botSeats: Set<Seat>;
  botTimer?: ReturnType<typeof setTimeout> | null;
  applyBid: (room: BridgeRoom, seat: Seat, call: BidCall) => { ok: boolean; error?: string };
  applyPlayCard: (room: BridgeRoom, seat: Seat, card: Card) => { ok: boolean; error?: string };
  applyRespondClaim: (room: BridgeRoom, seat: Seat, accept: boolean) => { ok: boolean; error?: string };
  broadcastTableState: (room: BridgeRoom) => void;
  broadcastRoomsList: () => void;
}

const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const SEAT_FULL_NAME: Record<Seat, string> = {
  N: 'North',
  E: 'East',
  S: 'South',
  W: 'West',
};

export function clearBotTimer(room: BridgeRoom): void {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

export function serializeRoomSummary(room: BridgeRoom) {
  const occupiedCount = SEATS.filter((s) => Boolean(room.seatNames[s]) || room.botSeats.has(s)).length;
  return {
    id: room.id,
    hasPassword: Boolean(room.password),
    boardNumber: room.game.boardNumber,
    phase: room.game.phase,
    occupiedCount,
    seats: room.seatNames,
    botSeats: Array.from(room.botSeats),
  };
}

export function addBotSeat(room: BridgeRoom, seat: Seat, botName?: string): boolean {
  if (room.seatNames[seat] && !room.botSeats.has(seat)) {
    return false;
  }
  room.botSeats.add(seat);
  room.seatNames[seat] = botName?.trim() || `Bot ${SEAT_FULL_NAME[seat]}`;
  return true;
}

export function fillOpenSeatsWithBots(room: BridgeRoom, seats?: Seat[]): Seat[] {
  const added: Seat[] = [];
  const targets = seats && seats.length > 0 ? seats : SEATS;
  for (const s of targets) {
    if (!room.seatNames[s] && !room.botSeats.has(s)) {
      room.botSeats.add(s);
      room.seatNames[s] = `Bot ${SEAT_FULL_NAME[s]}`;
      added.push(s);
    }
  }
  return added;
}

export function removeBotSeat(room: BridgeRoom, seat: Seat): boolean {
  if (!room.botSeats.has(seat)) return false;
  room.botSeats.delete(seat);
  delete room.seatNames[seat];
  return true;
}

export function scheduleBotTurn(
  room: BridgeRoom,
  delayMs = 450
): void {
  clearBotTimer(room);

  if (room.botSeats.size === 0) return;
  if (room.game.phase === 'WAITING' || room.game.phase === 'FINISHED') return;

  const previewAction = getNextBotAction(room.game, room.botSeats);
  if (!previewAction) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (room.botSeats.size === 0) return;
    if (room.game.phase === 'WAITING' || room.game.phase === 'FINISHED') return;

    const action = getNextBotAction(room.game, room.botSeats);
    if (!action) return;

    let result: { ok: boolean; error?: string } = { ok: false, error: 'Unsupported bot action' };
    if (action.type === 'BID') {
      result = room.applyBid(room, action.seat, action.call);
    } else if (action.type === 'PLAY_CARD') {
      const playActorSeat: Seat =
        room.game.phase === 'PLAYING' &&
        room.game.currentTurn === room.game.dummy &&
        room.game.contract &&
        action.seat === room.game.dummy
          ? room.game.contract.declarer
          : action.seat;
      result = room.applyPlayCard(room, playActorSeat, action.card);
    } else if (action.type === 'RESPOND_CLAIM') {
      result = room.applyRespondClaim(room, action.seat, action.accept);
    }

    if (result.ok) {
      room.broadcastTableState(room);
      room.broadcastRoomsList();
      scheduleBotTurn(room, delayMs);
    }
  }, delayMs);
}

export function registerBotSocketHandlers(
  _io: Server,
  socket: Socket,
  getRoom: (tableId: string) => BridgeRoom | undefined,
  onRoomMutated?: (room: BridgeRoom) => void
): void {
  socket.on(
    'add_bot',
    (payload: { tableId?: string; seat?: Seat; botName?: string }) => {
      const tableId = payload?.tableId?.trim();
      const seat = payload?.seat;
      if (!tableId || !seat || !SEATS.includes(seat)) return;

      const room = getRoom(tableId);
      if (!room) {
        socket.emit('error_msg', `Room "${tableId}" not found.`);
        return;
      }

      const added = addBotSeat(room, seat, payload?.botName);
      if (!added) {
        socket.emit('error_msg', `Seat ${seat} is already occupied.`);
        return;
      }

      onRoomMutated?.(room);
      room.broadcastTableState(room);
      room.broadcastRoomsList();
      scheduleBotTurn(room);
    }
  );

  socket.on(
    'fill_bots',
    (payload: { tableId?: string; seats?: Seat[] }) => {
      const tableId = payload?.tableId?.trim();
      if (!tableId) return;

      const room = getRoom(tableId);
      if (!room) {
        socket.emit('error_msg', `Room "${tableId}" not found.`);
        return;
      }

      const validSeats = Array.isArray(payload?.seats)
        ? payload.seats.filter((s): s is Seat => SEATS.includes(s))
        : undefined;

      fillOpenSeatsWithBots(room, validSeats);
      onRoomMutated?.(room);
      room.broadcastTableState(room);
      room.broadcastRoomsList();
      scheduleBotTurn(room);
    }
  );
}

export type {
  AuctionEntry,
  BidCall,
  Card,
  ClaimState,
  Seat,
  Strain,
  Suit,
};
