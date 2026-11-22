import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

type Seat = 'N' | 'E' | 'S' | 'W';
type Suit = 'C' | 'D' | 'H' | 'S';
type Strain = Suit | 'NT';
type Vulnerability = 'NONE' | 'NS' | 'EW' | 'BOTH';
type Phase = 'WAITING' | 'BIDDING' | 'PLAYING' | 'FINISHED';
type SpectatorHandMode = 'ALL_HANDS' | 'DUMMY_AND_REVEALED';

interface Card {
  suit: Suit;
  rank: number; // 2..14 (14 = Ace)
}

type BidCall =
  | { type: 'PASS' }
  | { type: 'DOUBLE' }
  | { type: 'REDOUBLE' }
  | { type: 'CONTRACT'; level: number; strain: Strain };

interface AuctionEntry {
  seat: Seat;
  call: BidCall;
  alerted?: boolean;
  explanation?: string;
  explanationRequestedBy?: Seat[];
}

interface ChatMessage {
  id: string;
  seat: Seat | 'SPECTATOR';
  senderName: string;
  text: string;
  timestamp: number;
}

interface ClaimState {
  claimedBy: Seat;
  claimedDeclarerTricks: number;
  acceptedBy: Seat[];
  rejectedBy: Seat[];
  rejectedRevealed: boolean;
}

interface AcceptedClaimRecord {
  claimedBy: Seat;
  claimedDeclarerTricks: number;
  acceptedBy: Seat[];
  partialTrick: { seat: Seat; card: Card }[];
  completedTricksCount: number;
  acceptedAtTrickNumber?: number;
  acceptedAtCardIndex?: number;
  acceptedAtCard?: { seat: Seat; card: Card } | null;
}

interface CompletedTrickRecord {
  winner: Seat;
  cards: { seat: Seat; card: Card }[];
}

interface ContractSpec {
  level: number;
  strain: Strain;
  declarer: Seat;
  doubled: 0 | 1 | 2;
}

interface GameState {
  boardNumber: number;
  dealer: Seat;
  vulnerability: Vulnerability;
  phase: Phase;
  hands: Partial<Record<Seat, Card[]>>;
  initialHands: Partial<Record<Seat, Card[]>>;
  auction: AuctionEntry[];
  contract: ContractSpec | null;
  dummy: Seat | null;
  currentTurn: Seat;
  currentTrick: { seat: Seat; card: Card }[];
  tricksHistory: CompletedTrickRecord[];
  tricksWon: { NS: number; EW: number };
  score: { NS: number; EW: number } | null;
  claim: ClaimState | null;
  acceptedClaim: AcceptedClaimRecord | null;
}

interface CompletedBoardRecord {
  id: number;
  board_number: number;
  dealer: Seat;
  vulnerability: Vulnerability;
  contract_text: string | null;
  declarer: Seat | null;
  tricks_ns: number;
  tricks_ew: number;
  score_ns: number;
  score_ew: number;
  tricks_history: CompletedTrickRecord[];
  initial_hands: Partial<Record<Seat, Card[]>>;
  auction: AuctionEntry[];
  accepted_claim: AcceptedClaimRecord | null;
  pbn: string;
}

interface RoomSummary {
  id: string;
  hasPassword: boolean;
  boardNumber: number;
  phase: Phase;
  occupiedCount: number;
  spectatorCount: number;
  botSeats: Seat[];
  seats: Partial<Record<Seat, string>>;
}

interface RoomState {
  id: string;
  password?: string;
  seatNames: Partial<Record<Seat, string>>;
  seatTokens: Partial<Record<Seat, string>>;
  seatSockets: Partial<Record<Seat, string>>;
  botSeats: Set<Seat>;
  spectatorSockets: Set<string>;
  spectatorHandModes: Map<string, SpectatorHandMode>;
  chatMessages: ChatMessage[];
  history: CompletedBoardRecord[];
  nextBoardRecordId: number;
  game: GameState;
}

const PORT = Number(process.env.PORT || 3001);
const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const SUITS: Suit[] = ['C', 'D', 'H', 'S'];
const STRAIN_ORDER: Strain[] = ['C', 'D', 'H', 'S', 'NT'];
const VUL_CYCLE: Vulnerability[] = ['NONE', 'NS', 'EW', 'BOTH'];
const SEAT_FULL_NAME: Record<Seat, string> = {
  N: 'North',
  E: 'East',
  S: 'South',
  W: 'West',
};
const RANK_TO_PBN: Record<number, string> = {
  14: 'A',
  13: 'K',
  12: 'Q',
  11: 'J',
  10: 'T',
  9: '9',
  8: '8',
  7: '7',
  6: '6',
  5: '5',
  4: '4',
  3: '3',
  2: '2',
};

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const rooms = new Map<string, RoomState>();
const botTimers = new Map<string, NodeJS.Timeout>();

function nextSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 1) % 4];
}

function partnerSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 2) % 4];
}

function sideOf(seat: Seat): 'NS' | 'EW' {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

function isSideVulnerable(vul: Vulnerability, side: 'NS' | 'EW'): boolean {
  if (vul === 'BOTH') return true;
  if (side === 'NS') return vul === 'NS';
  return vul === 'EW';
}

function cloneHands(hands: Partial<Record<Seat, Card[]>>): Partial<Record<Seat, Card[]>> {
  const copy: Partial<Record<Seat, Card[]>> = {};
  for (const s of SEATS) {
    if (hands[s]) {
      copy[s] = hands[s]!.map((c) => ({ suit: c.suit, rank: c.rank }));
    }
  }
  return copy;
}

function createShuffledHands(): Record<Seat, Card[]> {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ suit, rank });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return {
    N: deck.slice(0, 13),
    E: deck.slice(13, 26),
    S: deck.slice(26, 39),
    W: deck.slice(39, 52),
  };
}

function createInitialGame(boardNumber: number, hasAnyOccupant: boolean): GameState {
  const dealer = SEATS[(boardNumber - 1) % 4];
  const vulnerability = VUL_CYCLE[(boardNumber - 1) % 4];
  const dealt = createShuffledHands();
  return {
    boardNumber,
    dealer,
    vulnerability,
    phase: hasAnyOccupant ? 'BIDDING' : 'WAITING',
    hands: cloneHands(dealt),
    initialHands: cloneHands(dealt),
    auction: [],
    contract: null,
    dummy: null,
    currentTurn: dealer,
    currentTrick: [],
    tricksHistory: [],
    tricksWon: { NS: 0, EW: 0 },
    score: null,
    claim: null,
    acceptedClaim: null,
  };
}

function getOccupiedCount(room: RoomState): number {
  return SEATS.filter((s) => Boolean(room.seatNames[s]) || room.botSeats.has(s)).length;
}

function ensureSeatDisplayNames(room: RoomState): void {
  for (const s of SEATS) {
    if (room.botSeats.has(s) && !room.seatNames[s]) {
      room.seatNames[s] = `Bot ${SEAT_FULL_NAME[s]}`;
    }
  }
}

function buildRoomSummary(room: RoomState): RoomSummary {
  ensureSeatDisplayNames(room);
  const seatsCopy: Partial<Record<Seat, string>> = {};
  for (const s of SEATS) {
    if (room.seatNames[s]) {
      seatsCopy[s] = room.seatNames[s]!;
    }
  }
  return {
    id: room.id,
    hasPassword: Boolean(room.password),
    boardNumber: room.game.boardNumber,
    phase: room.game.phase,
    occupiedCount: getOccupiedCount(room),
    spectatorCount: room.spectatorSockets.size,
    botSeats: Array.from(room.botSeats),
    seats: seatsCopy,
  };
}

function getAllRoomSummaries(): RoomSummary[] {
  return Array.from(rooms.values()).map(buildRoomSummary);
}

function broadcastRoomsList(): void {
  io.emit('rooms_updated', getAllRoomSummaries());
}

function cleanupEmptyRooms(): number {
  let removed = 0;
  for (const [roomId, room] of rooms.entries()) {
    if (getOccupiedCount(room) === 0 && room.spectatorSockets.size === 0) {
      const timer = botTimers.get(roomId);
      if (timer) {
        clearTimeout(timer);
        botTimers.delete(roomId);
      }
      rooms.delete(roomId);
      removed += 1;
    }
  }
  return removed;
}

function getOrCreateRoom(roomId: string, password?: string): RoomState {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const newRoom: RoomState = {
    id: roomId,
    password: password || undefined,
    seatNames: {},
    seatTokens: {},
    seatSockets: {},
    botSeats: new Set<Seat>(),
    spectatorSockets: new Set<string>(),
    spectatorHandModes: new Map<string, SpectatorHandMode>(),
    chatMessages: [],
    history: [],
    nextBoardRecordId: 1,
    game: createInitialGame(1, false),
  };
  rooms.set(roomId, newRoom);
  return newRoom;
}

function isLegalBidCall(auction: AuctionEntry[], seat: Seat, call: BidCall): boolean {
  let lastContract: { seat: Seat; level: number; strain: Strain } | null = null;
  let doubled: 0 | 1 | 2 = 0;

  for (const entry of auction) {
    if (entry.call.type === 'CONTRACT') {
      lastContract = { seat: entry.seat, level: entry.call.level, strain: entry.call.strain };
      doubled = 0;
    } else if (entry.call.type === 'DOUBLE') {
      doubled = 1;
    } else if (entry.call.type === 'REDOUBLE') {
      doubled = 2;
    }
  }

  if (call.type === 'PASS') return true;
  if (call.type === 'DOUBLE') {
    return Boolean(lastContract && doubled === 0 && sideOf(lastContract.seat) !== sideOf(seat));
  }
  if (call.type === 'REDOUBLE') {
    return Boolean(lastContract && doubled === 1 && sideOf(lastContract.seat) === sideOf(seat));
  }
  if (call.level < 1 || call.level > 7) return false;
  if (!lastContract) return true;
  if (call.level !== lastContract.level) return call.level > lastContract.level;
  return STRAIN_ORDER.indexOf(call.strain) > STRAIN_ORDER.indexOf(lastContract.strain);
}

function resolveAuction(auction: AuctionEntry[]): {
  finished: boolean;
  passedOut: boolean;
  contract: ContractSpec | null;
} {
  if (auction.length < 4) {
    return { finished: false, passedOut: false, contract: null };
  }

  let lastContractIdx = -1;
  for (let i = 0; i < auction.length; i++) {
    if (auction[i].call.type === 'CONTRACT') {
      lastContractIdx = i;
    }
  }

  if (lastContractIdx === -1) {
    if (auction.length >= 4 && auction.slice(-4).every((e) => e.call.type === 'PASS')) {
      return { finished: true, passedOut: true, contract: null };
    }
    return { finished: false, passedOut: false, contract: null };
  }

  const trailingPasses = auction.slice(lastContractIdx + 1);
  if (trailingPasses.length < 3 || !trailingPasses.every((e) => e.call.type === 'PASS')) {
    return { finished: false, passedOut: false, contract: null };
  }

  const contractEntry = auction[lastContractIdx];
  const contractCall = contractEntry.call as Extract<BidCall, { type: 'CONTRACT' }>;
  const winningSide = sideOf(contractEntry.seat);

  let declarer = contractEntry.seat;
  for (const entry of auction) {
    if (
      entry.call.type === 'CONTRACT' &&
      sideOf(entry.seat) === winningSide &&
      entry.call.strain === contractCall.strain
    ) {
      declarer = entry.seat;
      break;
    }
  }

  let doubled: 0 | 1 | 2 = 0;
  for (let i = lastContractIdx + 1; i < auction.length; i++) {
    if (auction[i].call.type === 'DOUBLE') doubled = 1;
    else if (auction[i].call.type === 'REDOUBLE') doubled = 2;
  }

  return {
    finished: true,
    passedOut: false,
    contract: {
      level: contractCall.level,
      strain: contractCall.strain,
      declarer,
      doubled,
    },
  };
}

function determineTrickWinner(
  cards: { seat: Seat; card: Card }[],
  trump: Strain | null
): Seat {
  const leadSuit = cards[0].card.suit;
  const hasTrump = trump && trump !== 'NT';
  const trumpSuit = hasTrump ? (trump as Suit) : null;

  let best = cards[0];
  for (let i = 1; i < cards.length; i++) {
    const cur = cards[i];
    const bestIsTrump = Boolean(trumpSuit && best.card.suit === trumpSuit);
    const curIsTrump = Boolean(trumpSuit && cur.card.suit === trumpSuit);

    if (curIsTrump && !bestIsTrump) {
      best = cur;
    } else if (curIsTrump && bestIsTrump) {
      if (cur.card.rank > best.card.rank) best = cur;
    } else if (!bestIsTrump && !curIsTrump && cur.card.suit === leadSuit) {
      if (best.card.suit !== leadSuit || cur.card.rank > best.card.rank) {
        best = cur;
      }
    }
  }
  return best.seat;
}

function calculateDuplicateScore(
  contract: ContractSpec | null,
  tricksWon: { NS: number; EW: number },
  vul: Vulnerability
): { NS: number; EW: number } {
  if (!contract) return { NS: 0, EW: 0 };
  const declSide = sideOf(contract.declarer);
  const defSide: 'NS' | 'EW' = declSide === 'NS' ? 'EW' : 'NS';
  const isVul = isSideVulnerable(vul, declSide);
  const tricksMade = tricksWon[declSide];
  const needed = 6 + contract.level;
  const diff = tricksMade - needed;

  let total = 0;

  if (diff >= 0) {
    const baseTrickPointsPerTrick =
      contract.strain === 'C' || contract.strain === 'D' ? 20 : 30;
    let contractPoints = contract.level * baseTrickPointsPerTrick;
    if (contract.strain === 'NT') {
      contractPoints += 10;
    }
    if (contract.doubled === 1) contractPoints *= 2;
    else if (contract.doubled === 2) contractPoints *= 4;

    const gameBonus = contractPoints >= 100 ? (isVul ? 500 : 300) : 50;
    const slamBonus =
      contract.level === 7
        ? isVul
          ? 1500
          : 1000
        : contract.level === 6
        ? isVul
          ? 750
          : 500
        : 0;
    const insultBonus =
      contract.doubled === 1 ? 50 : contract.doubled === 2 ? 100 : 0;

    let overtrickPoints = 0;
    if (diff > 0) {
      if (contract.doubled === 0) {
        overtrickPoints = diff * baseTrickPointsPerTrick;
      } else if (contract.doubled === 1) {
        overtrickPoints = diff * (isVul ? 200 : 100);
      } else {
        overtrickPoints = diff * (isVul ? 400 : 200);
      }
    }

    total = contractPoints + gameBonus + slamBonus + insultBonus + overtrickPoints;
    return declSide === 'NS' ? { NS: total, EW: 0 } : { NS: 0, EW: total };
  }

  const undertricks = Math.abs(diff);
  let penalty = 0;
  if (contract.doubled === 0) {
    penalty = undertricks * (isVul ? 100 : 50);
  } else if (contract.doubled === 1) {
    if (!isVul) {
      for (let u = 1; u <= undertricks; u++) {
        if (u === 1) penalty += 100;
        else if (u <= 3) penalty += 200;
        else penalty += 300;
      }
    } else {
      for (let u = 1; u <= undertricks; u++) {
        penalty += u === 1 ? 200 : 300;
      }
    }
  } else {
    if (!isVul) {
      for (let u = 1; u <= undertricks; u++) {
        if (u === 1) penalty += 200;
        else if (u <= 3) penalty += 400;
        else penalty += 600;
      }
    } else {
      for (let u = 1; u <= undertricks; u++) {
        penalty += u === 1 ? 400 : 600;
      }
    }
  }

  return defSide === 'NS' ? { NS: penalty, EW: 0 } : { NS: 0, EW: penalty };
}

function formatContractText(contract: ContractSpec | null): string | null {
  if (!contract) return 'Pass';
  const suffix =
    contract.doubled === 1 ? 'X' : contract.doubled === 2 ? 'XX' : '';
  return `${contract.level}${contract.strain}${suffix}`;
}

function buildPbnString(room: RoomState, game: GameState): string {
  const lines: string[] = [];
  lines.push(`[Event "Casual Bridge Room ${room.id}"]`);
  lines.push(`[Board "${game.boardNumber}"]`);
  lines.push(`[Dealer "${game.dealer}"]`);
  lines.push(`[Vulnerable "${game.vulnerability}"]`);
  lines.push(`[Contract "${formatContractText(game.contract) || 'Pass'}"]`);
  lines.push(`[Declarer "${game.contract?.declarer || ''}"]`);
  lines.push(`[Score "NS ${game.score?.NS ?? 0} EW ${game.score?.EW ?? 0}"]`);

  const dealParts: string[] = [];
  for (let i = 0; i < 4; i++) {
    const s = SEATS[(SEATS.indexOf(game.dealer) + i) % 4];
    const h = game.initialHands[s] || [];
    const bySuit = (['S', 'H', 'D', 'C'] as Suit[]).map((suit) =>
      h
        .filter((c) => c.suit === suit)
        .sort((a, b) => b.rank - a.rank)
        .map((c) => RANK_TO_PBN[c.rank] || '')
        .join('')
    );
    dealParts.push(bySuit.join('.'));
  }
  lines.push(`[Deal "${game.dealer}:${dealParts.join(' ')}"]`);

  const playTokens: string[] = [];
  for (const tr of game.tricksHistory) {
    for (const p of tr.cards) {
      playTokens.push(`${p.card.suit}${RANK_TO_PBN[p.card.rank] || ''}`);
    }
  }
  if (playTokens.length > 0) {
    lines.push(`[PlaySeat "${game.tricksHistory[0]?.cards[0]?.seat || game.dealer}"]`);
    lines.push(`[Play "${playTokens.join(' ')}"]`);
  }

  return lines.join('\n');
}

function finalizeBoard(room: RoomState, acceptedClaimOverride?: AcceptedClaimRecord | null): void {
  const game = room.game;
  if (game.phase === 'FINISHED') return;

  game.phase = 'FINISHED';
  game.claim = null;
  if (acceptedClaimOverride) {
    game.acceptedClaim = acceptedClaimOverride;
  }

  const score = calculateDuplicateScore(game.contract, game.tricksWon, game.vulnerability);
  game.score = score;

  const record: CompletedBoardRecord = {
    id: room.nextBoardRecordId++,
    board_number: game.boardNumber,
    dealer: game.dealer,
    vulnerability: game.vulnerability,
    contract_text: formatContractText(game.contract),
    declarer: game.contract?.declarer || null,
    tricks_ns: game.tricksWon.NS,
    tricks_ew: game.tricksWon.EW,
    score_ns: score.NS,
    score_ew: score.EW,
    tricks_history: game.tricksHistory.map((t) => ({
      winner: t.winner,
      cards: t.cards.map((c) => ({ seat: c.seat, card: { ...c.card } })),
    })),
    initial_hands: cloneHands(game.initialHands),
    auction: game.auction.map((a) => ({ ...a, call: { ...a.call } })),
    accepted_claim: game.acceptedClaim ? { ...game.acceptedClaim } : null,
    pbn: buildPbnString(room, game),
  };
  room.history.push(record);
}

function getVisibleHandsForSeat(
  game: GameState,
  viewerSeat: Seat | null,
  isSpectator = false,
  spectatorMode: SpectatorHandMode = 'ALL_HANDS'
): Partial<Record<Seat, Card[]>> {
  const revealAll =
    game.phase === 'FINISHED' ||
    Boolean(game.claim && !game.claim.rejectedRevealed) ||
    Boolean(game.acceptedClaim) ||
    Boolean(isSpectator && spectatorMode === 'ALL_HANDS');

  const visible: Partial<Record<Seat, Card[]>> = {};
  for (const s of SEATS) {
    const actual = game.hands[s] || [];
    const dummyVisibleDuringPlay =
      game.phase === 'PLAYING' &&
      game.dummy === s &&
      (isSpectator || game.currentTrick.length > 0 || game.tricksHistory.length > 0);

    const canSee =
      revealAll ||
      (viewerSeat && s === viewerSeat) ||
      dummyVisibleDuringPlay;

    if (canSee) {
      visible[s] = actual.map((c) => ({ ...c }));
    } else {
      visible[s] = actual.map(() => ({ suit: 'C', rank: 0 }));
    }
  }
  return visible;
}

function emitTableStateToRoom(room: RoomState): void {
  ensureSeatDisplayNames(room);
  const botSeatsList = Array.from(room.botSeats);
  const seatsCopy: Partial<Record<Seat, string>> = {};
  for (const s of SEATS) {
    if (room.seatNames[s]) seatsCopy[s] = room.seatNames[s]!;
  }

  for (const [socketId, sock] of io.sockets.sockets.entries()) {
    const assignedSeat = (Object.keys(room.seatSockets) as Seat[]).find(
      (s) => room.seatSockets[s] === socketId
    );
    const isSpectator = room.spectatorSockets.has(socketId) && !assignedSeat;
    if (!assignedSeat && !isSpectator) continue;

    const spectatorMode: SpectatorHandMode =
      room.spectatorHandModes.get(socketId) || 'ALL_HANDS';

    sock.emit('table_state', {
      tableId: room.id,
      mySeat: assignedSeat || null,
      isSpectator,
      spectatorHandMode: spectatorMode,
      role: assignedSeat ? 'PLAYER' : 'SPECTATOR',
      playerName: assignedSeat ? room.seatNames[assignedSeat] : 'Spectator',
      reconnectToken: assignedSeat ? room.seatTokens[assignedSeat] : undefined,
      seatNames: seatsCopy,
      botSeats: botSeatsList,
      chatMessages: room.chatMessages,
      game: {
        ...room.game,
        hands: getVisibleHandsForSeat(
          room.game,
          assignedSeat || null,
          isSpectator,
          spectatorMode
        ),
        initialHands:
          room.game.phase === 'FINISHED' ||
          room.game.acceptedClaim ||
          (isSpectator && spectatorMode === 'ALL_HANDS')
            ? cloneHands(room.game.initialHands)
            : undefined,
      },
    });
  }

  io.emit('room_updated', buildRoomSummary(room));
  scheduleBotTurnIfNeeded(room);
}

function applyBid(room: RoomState, seat: Seat, call: BidCall): boolean {
  const g = room.game;
  if (g.phase !== 'BIDDING' || g.currentTurn !== seat) return false;
  if (!isLegalBidCall(g.auction, seat, call)) return false;

  g.auction.push({ seat, call });
  const outcome = resolveAuction(g.auction);

  if (outcome.finished) {
    if (outcome.passedOut || !outcome.contract) {
      finalizeBoard(room, null);
    } else {
      g.contract = outcome.contract;
      g.dummy = partnerSeat(outcome.contract.declarer);
      g.phase = 'PLAYING';
      g.currentTurn = nextSeat(outcome.contract.declarer);
      g.currentTrick = [];
      g.tricksHistory = [];
      g.tricksWon = { NS: 0, EW: 0 };
    }
  } else {
    g.currentTurn = nextSeat(seat);
  }
  return true;
}

function applyCardPlay(room: RoomState, actingSeat: Seat, card: Card): boolean {
  const g = room.game;
  if (g.phase !== 'PLAYING') return false;
  if (g.claim && !g.claim.rejectedRevealed) return false;
  if (g.currentTurn !== actingSeat) return false;

  const hand = g.hands[actingSeat] || [];
  const cardIdx = hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
  if (cardIdx === -1) return false;

  if (g.currentTrick.length > 0) {
    const leadSuit = g.currentTrick[0].card.suit;
    const hasLeadSuit = hand.some((c) => c.suit === leadSuit);
    if (hasLeadSuit && card.suit !== leadSuit) {
      return false;
    }
  }

  hand.splice(cardIdx, 1);
  g.currentTrick.push({ seat: actingSeat, card: { suit: card.suit, rank: card.rank } });

  if (g.currentTrick.length === 4) {
    const completedCards = g.currentTrick.map((p) => ({ seat: p.seat, card: { ...p.card } }));
    const winner = determineTrickWinner(completedCards, g.contract?.strain || null);
    g.tricksHistory.push({ winner, cards: completedCards });
    g.tricksWon[sideOf(winner)] += 1;
    g.currentTrick = [];
    g.currentTurn = winner;

    if (g.tricksHistory.length === 13) {
      finalizeBoard(room, null);
    }
  } else {
    g.currentTurn = nextSeat(actingSeat);
  }
  return true;
}

function chooseBotBid(room: RoomState, seat: Seat): BidCall {
  const g = room.game;
  const hand = g.hands[seat] || [];
  let hcp = 0;
  const suitCounts: Record<Suit, number> = { C: 0, D: 0, H: 0, S: 0 };
  for (const c of hand) {
    suitCounts[c.suit] += 1;
    if (c.rank === 14) hcp += 4;
    else if (c.rank === 13) hcp += 3;
    else if (c.rank === 12) hcp += 2;
    else if (c.rank === 11) hcp += 1;
  }

  const longestSuit = (['S', 'H', 'D', 'C'] as Suit[]).sort(
    (a, b) => suitCounts[b] - suitCounts[a]
  )[0];

  const desiredLevel = hcp >= 20 ? 3 : hcp >= 16 ? 2 : hcp >= 12 ? 1 : 0;
  if (desiredLevel >= 1) {
    const preferredStrains: Strain[] =
      suitCounts[longestSuit] >= 5 ? [longestSuit, 'NT'] : ['NT', longestSuit];
    for (const st of preferredStrains) {
      const candidate: BidCall = { type: 'CONTRACT', level: desiredLevel, strain: st };
      if (isLegalBidCall(g.auction, seat, candidate)) {
        return candidate;
      }
    }
  }
  return { type: 'PASS' };
}

function chooseBotCard(room: RoomState, actingSeat: Seat): Card | null {
  const g = room.game;
  const hand = g.hands[actingSeat] || [];
  if (hand.length === 0) return null;

  let legal = hand;
  if (g.currentTrick.length > 0) {
    const leadSuit = g.currentTrick[0].card.suit;
    const sameSuit = hand.filter((c) => c.suit === leadSuit);
    if (sameSuit.length > 0) legal = sameSuit;
  }

  const sorted = [...legal].sort((a, b) => a.rank - b.rank);
  return sorted[0];
}

function scheduleBotTurnIfNeeded(room: RoomState): void {
  const existingTimer = botTimers.get(room.id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    botTimers.delete(room.id);
  }

  const g = room.game;
  if (g.phase === 'FINISHED' || g.phase === 'WAITING') return;

  if (g.claim && !g.claim.rejectedRevealed) {
    const pendingDefenders = SEATS.filter(
      (s) =>
        s !== g.claim!.claimedBy &&
        sideOf(s) !== sideOf(g.claim!.claimedBy) &&
        !g.claim!.acceptedBy.includes(s) &&
        !g.claim!.rejectedBy.includes(s)
    );
    const botDefender = pendingDefenders.find((s) => room.botSeats.has(s));
    if (botDefender) {
      const timer = setTimeout(() => {
        botTimers.delete(room.id);
        const latestRoom = rooms.get(room.id);
        if (!latestRoom || !latestRoom.game.claim || latestRoom.game.claim.rejectedRevealed) return;
        const claimObj = latestRoom.game.claim;
        if (!claimObj.acceptedBy.includes(botDefender)) {
          claimObj.acceptedBy.push(botDefender);
        }
        const declSide = sideOf(claimObj.claimedBy);
        const defSide: 'NS' | 'EW' = declSide === 'NS' ? 'EW' : 'NS';
        latestRoom.game.tricksWon[declSide] = claimObj.claimedDeclarerTricks;
        latestRoom.game.tricksWon[defSide] = 13 - claimObj.claimedDeclarerTricks;

        const acceptedRecord: AcceptedClaimRecord = {
          claimedBy: claimObj.claimedBy,
          claimedDeclarerTricks: claimObj.claimedDeclarerTricks,
          acceptedBy: [...claimObj.acceptedBy],
          partialTrick: latestRoom.game.currentTrick.map((p) => ({
            seat: p.seat,
            card: { ...p.card },
          })),
          completedTricksCount: latestRoom.game.tricksHistory.length,
          acceptedAtTrickNumber: latestRoom.game.tricksHistory.length + 1,
          acceptedAtCardIndex: latestRoom.game.currentTrick.length,
          acceptedAtCard:
            latestRoom.game.currentTrick.length > 0
              ? latestRoom.game.currentTrick[latestRoom.game.currentTrick.length - 1]
              : null,
        };
        finalizeBoard(latestRoom, acceptedRecord);
        emitTableStateToRoom(latestRoom);
      }, 250);
      botTimers.set(room.id, timer);
    }
    return;
  }

  const turnSeat = g.currentTurn;
  if (!room.botSeats.has(turnSeat)) return;

  const delayMs = getOccupiedCount(room) === 4 && room.botSeats.size === 4 ? 180 : 320;
  const timer = setTimeout(() => {
    botTimers.delete(room.id);
    const latestRoom = rooms.get(room.id);
    if (!latestRoom) return;
    const latestGame = latestRoom.game;
    if (latestGame.currentTurn !== turnSeat || !latestRoom.botSeats.has(turnSeat)) return;

    if (latestGame.phase === 'BIDDING') {
      const botBid = chooseBotBid(latestRoom, turnSeat);
      if (applyBid(latestRoom, turnSeat, botBid)) {
        emitTableStateToRoom(latestRoom);
      }
    } else if (latestGame.phase === 'PLAYING') {
      const actingSeat =
        latestGame.currentTurn === latestGame.dummy && latestGame.contract?.declarer
          ? latestGame.dummy
          : turnSeat;
      const botCard = chooseBotCard(latestRoom, actingSeat);
      if (botCard && applyCardPlay(latestRoom, actingSeat, botCard)) {
        emitTableStateToRoom(latestRoom);
      }
    }
  }, delayMs);

  botTimers.set(room.id, timer);
}

function addBotToRoomSeat(room: RoomState, seat: Seat, botName?: string): boolean {
  if (!SEATS.includes(seat)) return false;
  if (room.seatSockets[seat] || room.seatTokens[seat]) return false;

  room.botSeats.add(seat);
  room.seatNames[seat] = (botName || `Bot ${SEAT_FULL_NAME[seat]}`).trim();
  delete room.seatTokens[seat];
  delete room.seatSockets[seat];

  if (room.game.phase === 'WAITING') {
    room.game.phase = 'BIDDING';
  }
  return true;
}

app.get('/api/rooms', (_req, res) => {
  res.json({ rooms: getAllRoomSummaries() });
});

app.post('/api/rooms/cleanup', (_req, res) => {
  const removed = cleanupEmptyRooms();
  broadcastRoomsList();
  res.json({ removed, rooms: getAllRoomSummaries() });
});

app.get('/api/boards/:roomId', (req, res) => {
  const roomId = decodeURIComponent(req.params.roomId || '').trim();
  const room = rooms.get(roomId);
  if (!room) {
    res.json({ boards: [] });
    return;
  }
  res.json({ boards: room.history });
});

io.on('connection', (socket: Socket) => {
  socket.on(
    'join_table',
    (payload: {
      tableId?: string;
      seat?: Seat | 'SPECTATOR';
      spectator?: boolean;
      spectatorHandMode?: SpectatorHandMode;
      playerName?: string;
      password?: string;
      reconnectToken?: string;
      fillBots?: boolean;
    }) => {
      const roomId = (payload?.tableId || '').trim();
      if (!roomId) {
        socket.emit('error_msg', 'Please provide a room ID.');
        return;
      }

      const existingRoom = rooms.get(roomId);
      const providedPw = (payload?.password || '').trim();
      if (existingRoom?.password && existingRoom.password !== providedPw) {
        socket.emit('error_msg', `Incorrect password for room "${roomId}".`);
        return;
      }

      const room = getOrCreateRoom(roomId, providedPw || undefined);

      // Detach socket from any previous room seats/spectator lists
      for (const r of rooms.values()) {
        r.spectatorSockets.delete(socket.id);
        r.spectatorHandModes.delete(socket.id);
        for (const s of SEATS) {
          if (r.seatSockets[s] === socket.id) {
            delete r.seatSockets[s];
          }
        }
      }

      const wantsSpectator = Boolean(payload?.spectator || payload?.seat === 'SPECTATOR');
      const requestedSeat =
        payload?.seat && payload.seat !== 'SPECTATOR' && SEATS.includes(payload.seat as Seat)
          ? (payload.seat as Seat)
          : null;

      if (wantsSpectator || !requestedSeat) {
        room.spectatorSockets.add(socket.id);
        const mode: SpectatorHandMode =
          payload?.spectatorHandMode === 'DUMMY_AND_REVEALED'
            ? 'DUMMY_AND_REVEALED'
            : 'ALL_HANDS';
        room.spectatorHandModes.set(socket.id, mode);

        if (payload?.fillBots) {
          for (const s of SEATS) {
            if (!room.seatNames[s] && !room.botSeats.has(s)) {
              addBotToRoomSeat(room, s, `Bot ${SEAT_FULL_NAME[s]}`);
            }
          }
        }
        if (getOccupiedCount(room) > 0 && room.game.phase === 'WAITING') {
          room.game.phase = 'BIDDING';
        }
        emitTableStateToRoom(room);
        return;
      }

      const existingToken = room.seatTokens[requestedSeat];
      const isReconnect = Boolean(
        existingToken && payload?.reconnectToken && existingToken === payload.reconnectToken
      );

      if (
        (room.seatNames[requestedSeat] || room.botSeats.has(requestedSeat)) &&
        !isReconnect
      ) {
        socket.emit(
          'error_msg',
          `Seat ${SEAT_FULL_NAME[requestedSeat]} (${requestedSeat}) is already taken.`
        );
        return;
      }

      const token =
        isReconnect && existingToken
          ? existingToken
          : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

      room.botSeats.delete(requestedSeat);
      room.seatNames[requestedSeat] =
        (payload?.playerName || '').trim() || `Player ${requestedSeat}`;
      room.seatTokens[requestedSeat] = token;
      room.seatSockets[requestedSeat] = socket.id;
      room.spectatorSockets.delete(socket.id);
      room.spectatorHandModes.delete(socket.id);

      if (payload?.fillBots) {
        for (const s of SEATS) {
          if (s === requestedSeat) continue;
          if (!room.seatNames[s] && !room.botSeats.has(s)) {
            addBotToRoomSeat(room, s, `Bot ${SEAT_FULL_NAME[s]}`);
          }
        }
      }

      if (room.game.phase === 'WAITING') {
        room.game.phase = 'BIDDING';
      }

      emitTableStateToRoom(room);
    }
  );

  socket.on(
    'set_spectator_view',
    (payload: { tableId?: string; mode?: SpectatorHandMode }) => {
      const roomId = (payload?.tableId || '').trim();
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room || !room.spectatorSockets.has(socket.id)) return;

      const nextMode: SpectatorHandMode =
        payload?.mode === 'DUMMY_AND_REVEALED' ? 'DUMMY_AND_REVEALED' : 'ALL_HANDS';
      room.spectatorHandModes.set(socket.id, nextMode);
      emitTableStateToRoom(room);
    }
  );

  socket.on(
    'add_bot',
    (payload: { tableId?: string; seat?: Seat; botName?: string }) => {
      const roomId = (payload?.tableId || '').trim();
      const seat = payload?.seat;
      if (!roomId || !seat || !SEATS.includes(seat)) return;

      const room = rooms.get(roomId);
      if (!room) return;

      if (addBotToRoomSeat(room, seat, payload?.botName)) {
        emitTableStateToRoom(room);
      }
    }
  );

  socket.on(
    'fill_bots',
    (payload: { tableId?: string; seats?: Seat[] }) => {
      const roomId = (payload?.tableId || '').trim();
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      const targetSeats =
        Array.isArray(payload?.seats) && payload.seats.length > 0
          ? payload.seats.filter((s): s is Seat => SEATS.includes(s))
          : SEATS;

      let changed = false;
      for (const s of targetSeats) {
        if (!room.seatNames[s] && !room.botSeats.has(s)) {
          if (addBotToRoomSeat(room, s, `Bot ${SEAT_FULL_NAME[s]}`)) {
            changed = true;
          }
        }
      }

      if (changed) {
        emitTableStateToRoom(room);
      }
    }
  );

  socket.on('kick_seat', (payload: { tableId?: string; seat?: Seat }) => {
    const roomId = (payload?.tableId || '').trim();
    const seat = payload?.seat;
    if (!roomId || !seat || !SEATS.includes(seat)) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const targetSockId = room.seatSockets[seat];
    room.botSeats.delete(seat);
    delete room.seatNames[seat];
    delete room.seatTokens[seat];
    delete room.seatSockets[seat];

    if (targetSockId) {
      const targetSock = io.sockets.sockets.get(targetSockId);
      if (targetSock) {
        targetSock.emit('removed_from_room', {
          tableId: room.id,
          seat,
          reason: `You were removed from ${SEAT_FULL_NAME[seat]} (${seat}) in "${room.id}".`,
        });
        targetSock.emit('left_table');
      }
    }

    emitTableStateToRoom(room);
  });

  socket.on('vacate_seat', (payload: { tableId?: string; seat?: Seat }) => {
    const roomId = (payload?.tableId || '').trim();
    const seat = payload?.seat;
    if (!roomId || !seat || !SEATS.includes(seat)) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.botSeats.delete(seat);
    delete room.seatNames[seat];
    delete room.seatTokens[seat];
    delete room.seatSockets[seat];
    emitTableStateToRoom(room);
  });

  socket.on('leave_table', (payload: { tableId?: string }) => {
    const roomId = (payload?.tableId || '').trim();
    const room = roomId ? rooms.get(roomId) : undefined;

    if (room) {
      room.spectatorSockets.delete(socket.id);
      room.spectatorHandModes.delete(socket.id);
      for (const s of SEATS) {
        if (room.seatSockets[s] === socket.id) {
          delete room.seatSockets[s];
          delete room.seatNames[s];
          delete room.seatTokens[s];
        }
      }
      if (getOccupiedCount(room) === 0 && room.spectatorSockets.size === 0) {
        const timer = botTimers.get(room.id);
        if (timer) {
          clearTimeout(timer);
          botTimers.delete(room.id);
        }
        rooms.delete(room.id);
      } else {
        emitTableStateToRoom(room);
      }
    }

    socket.emit('left_table');
    broadcastRoomsList();
  });

  socket.on('cleanup_empty_rooms', () => {
    cleanupEmptyRooms();
    broadcastRoomsList();
  });

  socket.on('make_bid', (payload: { tableId?: string; call?: BidCall }) => {
    const roomId = (payload?.tableId || '').trim();
    const call = payload?.call;
    if (!roomId || !call) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const seat = (Object.keys(room.seatSockets) as Seat[]).find(
      (s) => room.seatSockets[s] === socket.id
    );
    if (!seat) return;

    if (!applyBid(room, seat, call)) {
      socket.emit('error_msg', 'Illegal bid call or not your turn.');
      return;
    }
    emitTableStateToRoom(room);
  });

  socket.on(
    'alert_bid',
    (payload: { tableId?: string; bidIndex?: number; explanation?: string }) => {
      const roomId = (payload?.tableId || '').trim();
      const idx = payload?.bidIndex;
      if (!roomId || typeof idx !== 'number') return;
      const room = rooms.get(roomId);
      const entry = room?.game.auction[idx];
      if (!room || !entry) return;

      entry.alerted = true;
      if (payload?.explanation?.trim()) {
        entry.explanation = payload.explanation.trim();
      }
      emitTableStateToRoom(room);
    }
  );

  socket.on(
    'explain_bid',
    (payload: { tableId?: string; bidIndex?: number; explanation?: string }) => {
      const roomId = (payload?.tableId || '').trim();
      const idx = payload?.bidIndex;
      if (!roomId || typeof idx !== 'number') return;
      const room = rooms.get(roomId);
      const entry = room?.game.auction[idx];
      if (!room || !entry) return;

      entry.explanation = (payload?.explanation || '').trim();
      emitTableStateToRoom(room);
    }
  );

  socket.on('request_explanation', (payload: { tableId?: string; bidIndex?: number }) => {
    const roomId = (payload?.tableId || '').trim();
    const idx = payload?.bidIndex;
    if (!roomId || typeof idx !== 'number') return;
    const room = rooms.get(roomId);
    const entry = room?.game.auction[idx];
    if (!room || !entry) return;

    const requesterSeat = (Object.keys(room.seatSockets) as Seat[]).find(
      (s) => room.seatSockets[s] === socket.id
    );
    if (!requesterSeat) return;

    const list = entry.explanationRequestedBy || [];
    if (!list.includes(requesterSeat)) {
      list.push(requesterSeat);
    }
    entry.explanationRequestedBy = list;
    emitTableStateToRoom(room);
  });

  socket.on('play_card', (payload: { tableId?: string; card?: Card; seat?: Seat }) => {
    const roomId = (payload?.tableId || '').trim();
    const card = payload?.card;
    if (!roomId || !card) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const playerSeat = (Object.keys(room.seatSockets) as Seat[]).find(
      (s) => room.seatSockets[s] === socket.id
    );
    if (!playerSeat) return;

    const actingSeat: Seat =
      payload?.seat &&
      (payload.seat === playerSeat ||
        (room.game.contract?.declarer === playerSeat && payload.seat === room.game.dummy))
        ? payload.seat
        : playerSeat;

    if (!applyCardPlay(room, actingSeat, card)) {
      socket.emit('error_msg', 'Illegal card play or not your turn.');
      return;
    }
    emitTableStateToRoom(room);
  });

  socket.on('claim_tricks', (payload: { tableId?: string; claimedTricks?: number }) => {
    const roomId = (payload?.tableId || '').trim();
    const claimed = Number(payload?.claimedTricks);
    if (!roomId || !Number.isFinite(claimed)) return;
    const room = rooms.get(roomId);
    if (!room || room.game.phase !== 'PLAYING' || !room.game.contract) return;

    const seat = (Object.keys(room.seatSockets) as Seat[]).find(
      (s) => room.seatSockets[s] === socket.id
    );
    if (!seat || seat !== room.game.contract.declarer) return;

    const declSide = sideOf(seat);
    const currentDeclTricks = room.game.tricksWon[declSide];
    const remaining = 13 - (room.game.tricksWon.NS + room.game.tricksWon.EW);
    const maxClaim = currentDeclTricks + remaining;
    const bounded = Math.max(currentDeclTricks, Math.min(maxClaim, Math.round(claimed)));

    room.game.claim = {
      claimedBy: seat,
      claimedDeclarerTricks: bounded,
      acceptedBy: [seat],
      rejectedBy: [],
      rejectedRevealed: false,
    };
    emitTableStateToRoom(room);
  });

  socket.on('respond_claim', (payload: { tableId?: string; accept?: boolean }) => {
    const roomId = (payload?.tableId || '').trim();
    if (!roomId) return;
    const room = rooms.get(roomId);
    const claim = room?.game.claim;
    if (!room || !claim || claim.rejectedRevealed || !room.game.contract) return;

    const seat = (Object.keys(room.seatSockets) as Seat[]).find(
      (s) => room.seatSockets[s] === socket.id
    );
    const declSide = sideOf(claim.claimedBy);
    const defSide: 'NS' | 'EW' = declSide === 'NS' ? 'EW' : 'NS';
    if (!seat || sideOf(seat) !== defSide) return;

    if (payload?.accept) {
      if (!claim.acceptedBy.includes(seat)) {
        claim.acceptedBy.push(seat);
      }
      room.game.tricksWon[declSide] = claim.claimedDeclarerTricks;
      room.game.tricksWon[defSide] = 13 - claim.claimedDeclarerTricks;

      const acceptedRecord: AcceptedClaimRecord = {
        claimedBy: claim.claimedBy,
        claimedDeclarerTricks: claim.claimedDeclarerTricks,
        acceptedBy: [...claim.acceptedBy],
        partialTrick: room.game.currentTrick.map((p) => ({
          seat: p.seat,
          card: { ...p.card },
        })),
        completedTricksCount: room.game.tricksHistory.length,
        acceptedAtTrickNumber: room.game.tricksHistory.length + 1,
        acceptedAtCardIndex: room.game.currentTrick.length,
        acceptedAtCard:
          room.game.currentTrick.length > 0
            ? room.game.currentTrick[room.game.currentTrick.length - 1]
            : null,
      };
      finalizeBoard(room, acceptedRecord);
    } else {
      if (!claim.rejectedBy.includes(seat)) {
        claim.rejectedBy.push(seat);
      }
      claim.rejectedRevealed = true;
    }

    emitTableStateToRoom(room);
  });

  socket.on('next_board', (payload: { tableId?: string }) => {
    const roomId = (payload?.tableId || '').trim();
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const nextNum = room.game.boardNumber + 1;
    room.game = createInitialGame(nextNum, getOccupiedCount(room) > 0);
    emitTableStateToRoom(room);
  });

  socket.on('send_chat', (payload: { tableId?: string; text?: string }) => {
    const roomId = (payload?.tableId || '').trim();
    const text = (payload?.text || '').trim();
    if (!roomId || !text) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const seat = (Object.keys(room.seatSockets) as Seat[]).find(
      (s) => room.seatSockets[s] === socket.id
    );
    if (!seat) return;

    const msg: ChatMessage = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      seat,
      senderName: room.seatNames[seat] || `Player ${seat}`,
      text: text.slice(0, 400),
      timestamp: Date.now(),
    };
    room.chatMessages.push(msg);
    if (room.chatMessages.length > 200) {
      room.chatMessages = room.chatMessages.slice(-200);
    }

    for (const [sockId, sock] of io.sockets.sockets.entries()) {
      const inRoomSeat = (Object.keys(room.seatSockets) as Seat[]).find(
        (s) => room.seatSockets[s] === sockId
      );
      if (inRoomSeat || room.spectatorSockets.has(sockId)) {
        sock.emit('chat_message', msg);
      }
    }
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      room.spectatorSockets.delete(socket.id);
      room.spectatorHandModes.delete(socket.id);
      for (const s of SEATS) {
        if (room.seatSockets[s] === socket.id) {
          delete room.seatSockets[s];
        }
      }
      io.emit('room_updated', buildRoomSummary(room));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Contract Bridge server listening on http://localhost:${PORT}`);
});