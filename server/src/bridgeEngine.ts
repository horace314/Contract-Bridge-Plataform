export type Seat = 'N' | 'E' | 'S' | 'W';
export type Suit = 'C' | 'D' | 'H' | 'S';
export type Strain = Suit | 'NT';
export type Vulnerability = 'NONE' | 'NS' | 'EW' | 'BOTH';

export interface Card {
  suit: Suit;
  rank: number; // 2..14 (14=A)
}

export type BidCall =
  | { type: 'PASS' }
  | { type: 'DOUBLE' }
  | { type: 'REDOUBLE' }
  | { type: 'CONTRACT'; level: number; strain: Strain; alert?: string };

export interface Contract {
  level: number;
  strain: Strain;
  declarer: Seat;
  doubled: 0 | 1 | 2;
}

export interface TrickPlay {
  seat: Seat;
  card: Card;
}

export interface ClaimState {
  claimedBy: Seat;
  claimedDeclarerTricks: number;
  acceptedBy: Seat[];
  rejectedBy: Seat[];
  rejectedRevealed: boolean;
}

export interface GameState {
  boardNumber: number;
  dealer: Seat;
  vulnerability: Vulnerability;
  phase: 'WAITING' | 'BIDDING' | 'PLAYING' | 'FINISHED';
  hands: Record<Seat, Card[]>;
  initialHands: Record<Seat, Card[]>;
  auction: { seat: Seat; call: BidCall }[];
  contract: Contract | null;
  dummy: Seat | null;
  dummyRevealed: boolean;
  currentTurn: Seat;
  currentTrick: TrickPlay[];
  tricksHistory: { winner: Seat; cards: TrickPlay[] }[];
  tricksWon: { NS: number; EW: number };
  score: { NS: number; EW: number } | null;
  claim: ClaimState | null;
}

const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const STRAIN_ORDER: Strain[] = ['C', 'D', 'H', 'S', 'NT'];

export function nextSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 1) % 4];
}

export function partnerSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 2) % 4];
}

export function sideOf(seat: Seat): 'NS' | 'EW' {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

export function getBoardMetadata(boardNumber: number): { dealer: Seat; vulnerability: Vulnerability } {
  const dealer = SEATS[(boardNumber - 1) % 4];
  const vulCycle: Vulnerability[] = [
    'NONE', 'NS', 'EW', 'BOTH',
    'NS', 'EW', 'BOTH', 'NONE',
    'EW', 'BOTH', 'NONE', 'NS',
    'BOTH', 'NONE', 'NS', 'EW'
  ];
  const vulnerability = vulCycle[((boardNumber - 1) % 16 + 16) % 16];
  return { dealer, vulnerability };
}

export function sortHand(cards: Card[]): Card[] {
  const suitOrder: Record<Suit, number> = { S: 0, H: 1, C: 2, D: 3 };
  return [...cards].sort((a, b) => {
    if (suitOrder[a.suit] !== suitOrder[b.suit]) {
      return suitOrder[a.suit] - suitOrder[b.suit];
    }
    return b.rank - a.rank;
  });
}

export function createShuffledDeck(): Card[] {
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
  return deck;
}

export function createNewBoard(boardNumber = 1): GameState {
  const { dealer, vulnerability } = getBoardMetadata(boardNumber);
  const deck = createShuffledDeck();
  const hands: Record<Seat, Card[]> = {
    N: sortHand(deck.slice(0, 13)),
    E: sortHand(deck.slice(13, 26)),
    S: sortHand(deck.slice(26, 39)),
    W: sortHand(deck.slice(39, 52)),
  };
  const initialHands: Record<Seat, Card[]> = {
    N: [...hands.N],
    E: [...hands.E],
    S: [...hands.S],
    W: [...hands.W],
  };

  return {
    boardNumber,
    dealer,
    vulnerability,
    phase: 'BIDDING',
    hands,
    initialHands,
    auction: [],
    contract: null,
    dummy: null,
    dummyRevealed: false,
    currentTurn: dealer,
    currentTrick: [],
    tricksHistory: [],
    tricksWon: { NS: 0, EW: 0 },
    score: null,
    claim: null,
  };
}

function isHigherContract(
  next: { level: number; strain: Strain },
  prev: { level: number; strain: Strain } | null
): boolean {
  if (!prev) return true;
  if (next.level !== prev.level) return next.level > prev.level;
  return STRAIN_ORDER.indexOf(next.strain) > STRAIN_ORDER.indexOf(prev.strain);
}

export function isValidBidCall(
  state: GameState,
  seat: Seat,
  call: BidCall
): { ok: boolean; error?: string } {
  if (state.phase !== 'BIDDING') return { ok: false, error: 'Not in bidding phase.' };
  if (state.currentTurn !== seat) return { ok: false, error: `It is ${seat}'s turn to bid.` };

  let lastContractEntry: { seat: Seat; level: number; strain: Strain } | null = null;
  let doubled: 0 | 1 | 2 = 0;

  for (const item of state.auction) {
    if (item.call.type === 'CONTRACT') {
      lastContractEntry = { seat: item.seat, level: item.call.level, strain: item.call.strain };
      doubled = 0;
    } else if (item.call.type === 'DOUBLE') {
      doubled = 1;
    } else if (item.call.type === 'REDOUBLE') {
      doubled = 2;
    }
  }

  if (call.type === 'CONTRACT') {
    if (call.level < 1 || call.level > 7) return { ok: false, error: 'Bid level must be 1 to 7.' };
    if (!isHigherContract(call, lastContractEntry)) {
      return { ok: false, error: 'Contract bid must outrank the previous contract.' };
    }
  } else if (call.type === 'DOUBLE') {
    if (!lastContractEntry || doubled !== 0 || sideOf(lastContractEntry.seat) === sideOf(seat)) {
      return { ok: false, error: 'Double is only legal over an opponent contract.' };
    }
  } else if (call.type === 'REDOUBLE') {
    if (!lastContractEntry || doubled !== 1 || sideOf(lastContractEntry.seat) !== sideOf(seat)) {
      return { ok: false, error: 'Redouble is only legal over an opponent double.' };
    }
  }

  return { ok: true };
}

export function applyBid(state: GameState, seat: Seat, call: BidCall): { ok: boolean; error?: string } {
  const check = isValidBidCall(state, seat, call);
  if (!check.ok) {
    return check;
  }

  state.auction.push({ seat, call });

  const len = state.auction.length;
  if (
    len === 4 &&
    state.auction.every((a) => a.call.type === 'PASS')
  ) {
    state.phase = 'FINISHED';
    state.score = { NS: 0, EW: 0 };
    return { ok: true };
  }

  if (
    len >= 4 &&
    state.auction[len - 1].call.type === 'PASS' &&
    state.auction[len - 2].call.type === 'PASS' &&
    state.auction[len - 3].call.type === 'PASS'
  ) {
    let winning: { seat: Seat; level: number; strain: Strain } | null = null;
    let finalDoubled: 0 | 1 | 2 = 0;
    for (const item of state.auction) {
      if (item.call.type === 'CONTRACT') {
        winning = { seat: item.seat, level: item.call.level, strain: item.call.strain };
        finalDoubled = 0;
      } else if (item.call.type === 'DOUBLE') {
        finalDoubled = 1;
      } else if (item.call.type === 'REDOUBLE') {
        finalDoubled = 2;
      }
    }

    if (winning) {
      const winningSide = sideOf(winning.seat);
      const declarerEntry = state.auction.find(
        (a) =>
          a.call.type === 'CONTRACT' &&
          a.call.strain === winning!.strain &&
          sideOf(a.seat) === winningSide
      )!;
      const declarer = declarerEntry.seat;
      state.contract = {
        level: winning.level,
        strain: winning.strain,
        declarer,
        doubled: finalDoubled,
      };
      state.dummy = partnerSeat(declarer);
      state.phase = 'PLAYING';
      state.currentTurn = nextSeat(declarer);
      return { ok: true };
    }
  }

  state.currentTurn = nextSeat(seat);
  return { ok: true };
}

function trickWinner(trick: TrickPlay[], trump: Strain): Seat {
  let best = trick[0];
  for (let i = 1; i < trick.length; i++) {
    const cur = trick[i];
    if (trump !== 'NT') {
      if (cur.card.suit === trump && best.card.suit !== trump) {
        best = cur;
        continue;
      }
      if (cur.card.suit !== trump && best.card.suit === trump) {
        continue;
      }
    }
    if (cur.card.suit === best.card.suit && cur.card.rank > best.card.rank) {
      best = cur;
    }
  }
  return best.seat;
}

export function calculateDuplicateScore(
  contract: Contract,
  tricksMade: number,
  vul: Vulnerability
): { NS: number; EW: number } {
  const declarerSide = sideOf(contract.declarer);
  const isVul = vul === 'BOTH' || vul === declarerSide;
  const target = 6 + contract.level;
  const diff = tricksMade - target;
  let pts = 0;

  if (diff >= 0) {
    let trickPts = 0;
    if (contract.strain === 'NT') {
      trickPts = 40 + (contract.level - 1) * 30;
    } else if (contract.strain === 'H' || contract.strain === 'S') {
      trickPts = contract.level * 30;
    } else {
      trickPts = contract.level * 20;
    }
    if (contract.doubled === 1) trickPts *= 2;
    if (contract.doubled === 2) trickPts *= 4;
    pts += trickPts;

    if (trickPts >= 100) {
      pts += isVul ? 500 : 300;
    } else {
      pts += 50;
    }

    if (contract.level === 6) pts += isVul ? 750 : 500;
    if (contract.level === 7) pts += isVul ? 1500 : 1000;

    if (contract.doubled === 1) pts += 50;
    if (contract.doubled === 2) pts += 100;

    if (diff > 0) {
      if (contract.doubled === 0) {
        const perOver = contract.strain === 'C' || contract.strain === 'D' ? 20 : 30;
        pts += diff * perOver;
      } else if (contract.doubled === 1) {
        pts += diff * (isVul ? 200 : 100);
      } else {
        pts += diff * (isVul ? 400 : 200);
      }
    }
  } else {
    const under = Math.abs(diff);
    let penalty = 0;
    if (contract.doubled === 0) {
      penalty = under * (isVul ? 100 : 50);
    } else {
      for (let i = 1; i <= under; i++) {
        if (i === 1) penalty += isVul ? 200 : 100;
        else if (i <= 3) penalty += isVul ? 300 : 200;
        else penalty += 300;
      }
      if (contract.doubled === 2) penalty *= 2;
    }
    pts = -penalty;
  }

  return declarerSide === 'NS' ? { NS: pts, EW: -pts } : { NS: -pts, EW: pts };
}

export function applyPlayCard(
  state: GameState,
  actorSeat: Seat,
  card: Card
): { ok: boolean; error?: string } {
  if (state.phase !== 'PLAYING' || !state.contract || !state.dummy) {
    return { ok: false, error: 'Game is not in card play phase.' };
  }
  if (state.claim && !state.claim.rejectedRevealed) {
    return { ok: false, error: 'Resolve pending claim before playing cards.' };
  }

  const turnSeat = state.currentTurn;
  const isDummyTurn = turnSeat === state.dummy;
  if (isDummyTurn) {
    if (actorSeat !== state.contract.declarer) {
      return { ok: false, error: `Declarer (${state.contract.declarer}) plays dummy's cards.` };
    }
  } else if (actorSeat !== turnSeat) {
    return { ok: false, error: `It is ${turnSeat}'s turn to play.` };
  }

  const hand = state.hands[turnSeat];
  const cardIdx = hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
  if (cardIdx === -1) {
    return { ok: false, error: 'Card not found in hand.' };
  }

  if (state.currentTrick.length > 0) {
    const leadSuit = state.currentTrick[0].card.suit;
    const hasLeadSuit = hand.some((c) => c.suit === leadSuit);
    if (hasLeadSuit && card.suit !== leadSuit) {
      return { ok: false, error: `Must follow suit (${leadSuit}).` };
    }
  }

  hand.splice(cardIdx, 1);
  state.currentTrick.push({ seat: turnSeat, card });

  if (!state.dummyRevealed && state.tricksHistory.length === 0 && state.currentTrick.length === 1) {
    state.dummyRevealed = true;
  }

  if (state.currentTrick.length === 4) {
    const winner = trickWinner(state.currentTrick, state.contract.strain);
    state.tricksHistory.push({ winner, cards: [...state.currentTrick] });
    state.tricksWon[sideOf(winner)] += 1;
    state.currentTrick = [];
    state.currentTurn = winner;

    if (state.tricksHistory.length === 13) {
      state.phase = 'FINISHED';
      const declarerSide = sideOf(state.contract.declarer);
      state.score = calculateDuplicateScore(
        state.contract,
        state.tricksWon[declarerSide],
        state.vulnerability
      );
    }
  } else {
    state.currentTurn = nextSeat(turnSeat);
  }

  return { ok: true };
}

export function initiateClaim(
  state: GameState,
  actorSeat: Seat,
  claimedDeclarerTricks: number
): { ok: boolean; error?: string } {
  if (state.phase !== 'PLAYING' || !state.contract) {
    return { ok: false, error: 'Claims can only be made during card play.' };
  }
  if (actorSeat !== state.contract.declarer) {
    return { ok: false, error: 'Only the declarer can claim tricks.' };
  }
  if (state.claim && !state.claim.rejectedRevealed) {
    return { ok: false, error: 'A claim is already awaiting defender response.' };
  }

  const declarerSide = sideOf(state.contract.declarer);
  const currentDeclarerTricks = state.tricksWon[declarerSide];
  const remainingTricks = 13 - (state.tricksWon.NS + state.tricksWon.EW);
  const maxPossible = currentDeclarerTricks + remainingTricks;

  if (
    !Number.isInteger(claimedDeclarerTricks) ||
    claimedDeclarerTricks < currentDeclarerTricks ||
    claimedDeclarerTricks > maxPossible
  ) {
    return {
      ok: false,
      error: `Claimed declarer tricks must be between ${currentDeclarerTricks} and ${maxPossible}.`,
    };
  }

  state.claim = {
    claimedBy: actorSeat,
    claimedDeclarerTricks,
    acceptedBy: [],
    rejectedBy: [],
    rejectedRevealed: false,
  };
  return { ok: true };
}

export function respondToClaim(
  state: GameState,
  actorSeat: Seat,
  accept: boolean
): { ok: boolean; error?: string } {
  if (!state.claim || state.phase !== 'PLAYING' || !state.contract) {
    return { ok: false, error: 'No active claim to respond to.' };
  }
  const declarerSide = sideOf(state.contract.declarer);
  if (sideOf(actorSeat) === declarerSide) {
    return { ok: false, error: 'Only defenders can accept or reject a claim.' };
  }

  if (accept) {
    if (!state.claim.acceptedBy.includes(actorSeat)) {
      state.claim.acceptedBy.push(actorSeat);
    }
    state.claim.rejectedBy = state.claim.rejectedBy.filter((s) => s !== actorSeat);
    const totalTricks = 13;
    const finalDeclarerTricks = state.claim.claimedDeclarerTricks;
    const finalDefTricks = totalTricks - finalDeclarerTricks;
    if (declarerSide === 'NS') {
      state.tricksWon = { NS: finalDeclarerTricks, EW: finalDefTricks };
    } else {
      state.tricksWon = { NS: finalDefTricks, EW: finalDeclarerTricks };
    }
    state.phase = 'FINISHED';
    state.score = calculateDuplicateScore(
      state.contract,
      finalDeclarerTricks,
      state.vulnerability
    );
    state.claim = null;
    return { ok: true };
  } else {
    if (!state.claim.rejectedBy.includes(actorSeat)) {
      state.claim.rejectedBy.push(actorSeat);
    }
    state.claim.rejectedRevealed = true;
    return { ok: true };
  }
}

export function sanitizeStateForSeat(state: GameState, viewerSeat: Seat | null) {
  const maskedHands: Partial<Record<Seat, Card[]>> = {};
  const declarerSide = state.contract ? sideOf(state.contract.declarer) : null;
  const isViewerDefender = Boolean(
    viewerSeat && declarerSide && sideOf(viewerSeat) !== declarerSide
  );
  const declarerShownToDefenders = Boolean(state.claim && isViewerDefender);

  for (const seat of SEATS) {
    const canSee =
      state.phase === 'FINISHED' ||
      seat === viewerSeat ||
      (state.dummyRevealed && seat === state.dummy) ||
      (seat === state.contract?.declarer && declarerShownToDefenders);
    if (canSee) {
      maskedHands[seat] = state.hands[seat];
    } else {
      maskedHands[seat] = state.hands[seat].map(() => ({ suit: 'S', rank: 0 }));
    }
  }
  return {
    boardNumber: state.boardNumber,
    dealer: state.dealer,
    vulnerability: state.vulnerability,
    phase: state.phase,
    hands: maskedHands,
    auction: state.auction,
    contract: state.contract,
    dummy: state.dummy,
    currentTurn: state.currentTurn,
    currentTrick: state.currentTrick,
    tricksHistory: state.tricksHistory,
    tricksWon: state.tricksWon,
    score: state.score,
    claim: state.claim,
  };
}

export function generatePBN(state: GameState): string {
  const rankMap: Record<number, string> = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' };
  const formatSuit = (cards: Card[], s: Suit) =>
    cards
      .filter((c) => c.suit === s)
      .sort((a, b) => b.rank - a.rank)
      .map((c) => rankMap[c.rank] || String(c.rank))
      .join('');

  const dealSeats: Seat[] = ['N', 'E', 'S', 'W'];
  const dealStr = dealSeats
    .map((s) =>
      (['S', 'H', 'D', 'C'] as Suit[]).map((suit) => formatSuit(state.initialHands[s], suit)).join('.')
    )
    .join(' ');

  const contractStr = state.contract
    ? `${state.contract.level}${state.contract.strain}${
        state.contract.doubled === 1 ? 'X' : state.contract.doubled === 2 ? 'XX' : ''
      }`
    : 'Pass';

  return [
    `[Board "${state.boardNumber}"]`,
    `[Dealer "${state.dealer}"]`,
    `[Vulnerable "${state.vulnerability}"]`,
    `[Deal "N:${dealStr}"]`,
    `[Declarer "${state.contract?.declarer || ''}"]`,
    `[Contract "${contractStr}"]`,
    `[Score "NS ${state.score?.NS ?? 0}"]`,
  ].join('\n');
}
