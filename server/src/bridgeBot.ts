export type Seat = 'N' | 'E' | 'S' | 'W';
export type Suit = 'C' | 'D' | 'H' | 'S';
export type Strain = Suit | 'NT';

export interface Card {
  suit: Suit;
  rank: number; // 2..14 (14 = Ace)
}

export type BidCall =
  | { type: 'PASS' }
  | { type: 'DOUBLE' }
  | { type: 'REDOUBLE' }
  | { type: 'CONTRACT'; level: number; strain: Strain };

export interface AuctionEntry {
  seat: Seat;
  call: BidCall;
  alerted?: boolean;
  explanation?: string;
  explanationRequestedBy?: Seat[];
}

export interface ClaimState {
  claimedBy: Seat;
  claimedDeclarerTricks: number;
  acceptedBy: Seat[];
  rejectedBy: Seat[];
  rejectedRevealed: boolean;
}

export interface BotGameState {
  boardNumber: number;
  dealer: Seat;
  vulnerability: 'NONE' | 'NS' | 'EW' | 'BOTH';
  phase: 'WAITING' | 'BIDDING' | 'PLAYING' | 'FINISHED';
  hands: Partial<Record<Seat, Card[]>>;
  auction: AuctionEntry[];
  contract: { level: number; strain: Strain; declarer: Seat; doubled: 0 | 1 | 2 } | null;
  dummy: Seat | null;
  currentTurn: Seat;
  currentTrick: { seat: Seat; card: Card }[];
  tricksHistory: { winner: Seat; cards: { seat: Seat; card: Card }[] }[];
  tricksWon: { NS: number; EW: number };
  claim: ClaimState | null;
}

export type BotAction =
  | { type: 'BID'; seat: Seat; call: BidCall }
  | { type: 'PLAY_CARD'; seat: Seat; card: Card }
  | { type: 'RESPOND_CLAIM'; seat: Seat; accept: boolean };

const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const STRAIN_ORDER: Strain[] = ['C', 'D', 'H', 'S', 'NT'];

export function sideOf(seat: Seat): 'NS' | 'EW' {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

export function partnerSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 2) % 4];
}

export function isSeatVulnerable(
  vulnerability: BotGameState['vulnerability'],
  seat: Seat
): boolean {
  if (vulnerability === 'BOTH') return true;
  if (vulnerability === 'NS') return sideOf(seat) === 'NS';
  if (vulnerability === 'EW') return sideOf(seat) === 'EW';
  return false;
}

export function evaluateHighCardPoints(cards: Card[]): number {
  let hcp = 0;
  for (const c of cards) {
    if (c.rank === 14) hcp += 4;
    else if (c.rank === 13) hcp += 3;
    else if (c.rank === 12) hcp += 2;
    else if (c.rank === 11) hcp += 1;
  }
  return hcp;
}

export function getSuitLengths(cards: Card[]): Record<Suit, number> {
  const counts: Record<Suit, number> = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of cards) {
    if (c.rank > 0 && counts[c.suit] !== undefined) {
      counts[c.suit] += 1;
    }
  }
  return counts;
}

export function evaluateTotalPoints(cards: Card[]): {
  hcp: number;
  distPoints: number;
  totalPoints: number;
  lengths: Record<Suit, number>;
  isBalanced: boolean;
} {
  const hcp = evaluateHighCardPoints(cards);
  const lengths = getSuitLengths(cards);
  const sortedLens = SUITS.map((s) => lengths[s]).sort((a, b) => b - a);

  let distPoints = 0;
  for (const s of SUITS) {
    const len = lengths[s];
    if (len >= 5) distPoints += len - 4; // +1 per card over 4
    else if (len === 0) distPoints += 3; // void
    else if (len === 1) distPoints += 2; // singleton
  }

  // Standard balanced shapes: 4-3-3-3, 4-4-3-2, 5-3-3-2
  const isBalanced =
    sortedLens[3] >= 2 &&
    sortedLens[0] <= 5 &&
    !(sortedLens[0] === 5 && sortedLens[1] >= 4) &&
    sortedLens[0] !== 6;

  return {
    hcp,
    distPoints,
    totalPoints: hcp + distPoints,
    lengths,
    isBalanced,
  };
}

export function getLegalBidCalls(auction: AuctionEntry[], seat: Seat): {
  lastContract: { seat: Seat; level: number; strain: Strain } | null;
  doubled: 0 | 1 | 2;
  canDouble: boolean;
  canRedouble: boolean;
  isLegal: (call: BidCall) => boolean;
} {
  let lastContract: { seat: Seat; level: number; strain: Strain } | null = null;
  let doubled: 0 | 1 | 2 = 0;

  for (const item of auction) {
    if (item.call.type === 'CONTRACT') {
      lastContract = { seat: item.seat, level: item.call.level, strain: item.call.strain };
      doubled = 0;
    } else if (item.call.type === 'DOUBLE') {
      doubled = 1;
    } else if (item.call.type === 'REDOUBLE') {
      doubled = 2;
    }
  }

  const canDouble = Boolean(
    lastContract && doubled === 0 && sideOf(lastContract.seat) !== sideOf(seat)
  );
  const canRedouble = Boolean(
    lastContract && doubled === 1 && sideOf(lastContract.seat) === sideOf(seat)
  );

  const isLegal = (call: BidCall): boolean => {
    if (call.type === 'PASS') return true;
    if (call.type === 'DOUBLE') return canDouble;
    if (call.type === 'REDOUBLE') return canRedouble;
    if (call.level < 1 || call.level > 7) return false;
    if (!lastContract) return true;
    if (call.level !== lastContract.level) return call.level > lastContract.level;
    return STRAIN_ORDER.indexOf(call.strain) > STRAIN_ORDER.indexOf(lastContract.strain);
  };

  return { lastContract, doubled, canDouble, canRedouble, isLegal };
}

function getPartnerContractBids(auction: AuctionEntry[], seat: Seat): { level: number; strain: Suit }[] {
  const pSeat = partnerSeat(seat);
  const result: { level: number; strain: Suit }[] = [];
  for (const entry of auction) {
    if (entry.seat === pSeat && entry.call.type === 'CONTRACT' && entry.call.strain !== 'NT') {
      result.push({ level: entry.call.level, strain: entry.call.strain });
    }
  }
  return result;
}

function chooseLongestSuit(lengths: Record<Suit, number>, hcpInSuit?: Record<Suit, number>): Suit {
  let bestSuit: Suit = 'S';
  let bestScore = -999;
  for (const s of SUITS) {
    const len = lengths[s];
    const suitHcp = hcpInSuit ? hcpInSuit[s] : 0;
    const score = len * 10 + suitHcp;
    if (score > bestScore) {
      bestScore = score;
      bestSuit = s;
    }
  }
  return bestSuit;
}

export function chooseBotBid(game: BotGameState, seat: Seat): BidCall {
  const hand = (game.hands[seat] || []).filter((c) => c.rank > 0);
  const { hcp, totalPoints, lengths, isBalanced } = evaluateTotalPoints(hand);
  const { lastContract, canDouble, isLegal } = getLegalBidCalls(game.auction, seat);

  const tryBid = (call: BidCall): BidCall | null => (isLegal(call) ? call : null);

  // 1. Opening bids (no contract bid yet)
  if (!lastContract) {
    if (hcp >= 15 && hcp <= 17 && isBalanced) {
      const bid = tryBid({ type: 'CONTRACT', level: 1, strain: 'NT' });
      if (bid) return bid;
    }
    if (totalPoints >= 12) {
      // Prefer 5+ card major first
      if (lengths.S >= 5 && lengths.S >= lengths.H) {
        const bid = tryBid({ type: 'CONTRACT', level: 1, strain: 'S' });
        if (bid) return bid;
      }
      if (lengths.H >= 5 && lengths.H > lengths.S) {
        const bid = tryBid({ type: 'CONTRACT', level: 1, strain: 'H' });
        if (bid) return bid;
      }
      // Otherwise longer minor
      const minor: Suit = lengths.D > lengths.C ? 'D' : 'C';
      const bid = tryBid({ type: 'CONTRACT', level: 1, strain: minor });
      if (bid) return bid;
    }
    return { type: 'PASS' };
  }

  // 2. Responding / competing after a contract exists
  const partnerSuits = getPartnerContractBids(game.auction, seat);
  const pSuit = partnerSuits.length > 0 ? partnerSuits[partnerSuits.length - 1].strain : null;

  // Raise partner's suit if we hold 3+ card support
  if (pSuit && lengths[pSuit] >= 3 && totalPoints >= 6) {
    const targetLevel = totalPoints >= 13 ? 4 : totalPoints >= 10 ? 3 : 2;
    for (let lvl = targetLevel; lvl >= 1; lvl--) {
      const candidate: BidCall = { type: 'CONTRACT', level: lvl, strain: pSuit };
      if (isLegal(candidate)) return candidate;
    }
  }

  // Balanced NT response when no major fit
  if (isBalanced && hcp >= 8) {
    const ntLevel = hcp >= 16 ? 3 : hcp >= 11 ? 2 : 1;
    for (let lvl = ntLevel; lvl >= 1; lvl--) {
      const candidate: BidCall = { type: 'CONTRACT', level: lvl, strain: 'NT' };
      if (isLegal(candidate)) return candidate;
    }
  }

  // Overcall / new suit with 10+ HCP and 5+ card suit
  if (hcp >= 10) {
    const bestSuit = chooseLongestSuit(lengths);
    if (lengths[bestSuit] >= 5) {
      const maxLevel = hcp >= 16 ? 2 : 1;
      for (let lvl = 1; lvl <= maxLevel; lvl++) {
        const candidate: BidCall = { type: 'CONTRACT', level: lvl, strain: bestSuit };
        if (isLegal(candidate)) return candidate;
      }
    }
  }

  // Penalty/competitive double only with strong hand (14+ HCP) against low opponent contract
  if (canDouble && hcp >= 14 && lastContract.level <= 2) {
    return { type: 'DOUBLE' };
  }

  return { type: 'PASS' };
}

function getTrickWinnerSeat(
  plays: { seat: Seat; card: Card }[],
  trump: Suit | null
): Seat {
  const leadSuit = plays[0].card.suit;
  let winner = plays[0];

  for (let i = 1; i < plays.length; i++) {
    const cur = plays[i];
    const winCard = winner.card;
    const curIsTrump = trump !== null && cur.card.suit === trump;
    const winIsTrump = trump !== null && winCard.suit === trump;

    if (curIsTrump && !winIsTrump) {
      winner = cur;
    } else if (curIsTrump && winIsTrump) {
      if (cur.card.rank > winCard.rank) winner = cur;
    } else if (!curIsTrump && !winIsTrump && cur.card.suit === leadSuit) {
      if (winCard.suit !== leadSuit || cur.card.rank > winCard.rank) {
        winner = cur;
      }
    }
  }
  return winner.seat;
}

function cardBeats(challenger: Card, currentBest: Card, trump: Suit | null): boolean {
  const chTrump = trump !== null && challenger.suit === trump;
  const bestTrump = trump !== null && currentBest.suit === trump;
  if (chTrump && !bestTrump) return true;
  if (!chTrump && bestTrump) return false;
  if (challenger.suit !== currentBest.suit) return false;
  return challenger.rank > currentBest.rank;
}

export function chooseBotCard(game: BotGameState, actingSeat: Seat): Card | null {
  const hand = (game.hands[actingSeat] || []).filter((c) => c.rank > 0);
  if (hand.length === 0) return null;

  const trump: Suit | null =
    game.contract && game.contract.strain !== 'NT' ? game.contract.strain : null;

  const sortedAsc = [...hand].sort((a, b) => a.rank - b.rank);
  const sortedDesc = [...hand].sort((a, b) => b.rank - a.rank);

  // Leading to a trick
  if (game.currentTrick.length === 0) {
    const nonTrump = trump ? sortedDesc.filter((c) => c.suit !== trump) : sortedDesc;
    const pool = nonTrump.length > 0 ? nonTrump : sortedDesc;
    // Lead highest card from longest suit
    const lengths = getSuitLengths(pool);
    let bestSuit: Suit = pool[0].suit;
    let maxLen = -1;
    for (const c of pool) {
      const len = lengths[c.suit] || 0;
      if (len > maxLen) {
        maxLen = len;
        bestSuit = c.suit;
      }
    }
    const suitCardsDesc = pool.filter((c) => c.suit === bestSuit).sort((a, b) => b.rank - a.rank);
    return suitCardsDesc[0] || pool[0];
  }

  // Following to an active trick
  const leadSuit = game.currentTrick[0].card.suit;
  const followingSuit = hand.filter((c) => c.suit === leadSuit);
  const legalCards = followingSuit.length > 0 ? followingSuit : hand;

  const currentWinnerSeat = getTrickWinnerSeat(game.currentTrick, trump);
  const partnerIsWinning = sideOf(currentWinnerSeat) === sideOf(actingSeat);

  // Determine current winning card in the trick
  let currentBestCard = game.currentTrick[0].card;
  for (let i = 1; i < game.currentTrick.length; i++) {
    if (cardBeats(game.currentTrick[i].card, currentBestCard, trump)) {
      currentBestCard = game.currentTrick[i].card;
    }
  }

  if (partnerIsWinning && followingSuit.length > 0) {
    // Play lowest card following suit to let partner hold the trick
    return [...followingSuit].sort((a, b) => a.rank - b.rank)[0];
  }

  // Find lowest legal card that can win the trick
  const winners = legalCards
    .filter((c) => cardBeats(c, currentBestCard, trump))
    .sort((a, b) => a.rank - b.rank);

  if (winners.length > 0) {
    return winners[0];
  }

  // Cannot win: discard/play lowest legal card (prefer non-trump if off-suit)
  if (followingSuit.length === 0 && trump) {
    const nonTrumpOff = legalCards.filter((c) => c.suit !== trump).sort((a, b) => a.rank - b.rank);
    if (nonTrumpOff.length > 0) return nonTrumpOff[0];
  }

  return [...legalCards].sort((a, b) => a.rank - b.rank)[0];
}

export function chooseBotClaimResponse(
  game: BotGameState,
  defenderSeat: Seat
): boolean {
  if (!game.claim || game.claim.rejectedRevealed) return false;
  if (!game.contract) return false;

  const declarerSide = sideOf(game.contract.declarer);
  if (sideOf(defenderSeat) === declarerSide) return false;

  const tricksPlayedSoFar = game.tricksWon.NS + game.tricksWon.EW;
  const remainingTricks = Math.max(0, 13 - tricksPlayedSoFar);
  const currentDeclarerTricks = game.tricksWon[declarerSide];
  const maxPossibleDeclarerTricks = currentDeclarerTricks + remainingTricks;

  if (game.claim.claimedDeclarerTricks > maxPossibleDeclarerTricks) {
    return false;
  }

  // Reject if defender holds an Ace or King in a non-trump suit with <= 6 tricks remaining
  const hand = (game.hands[defenderSeat] || []).filter((c) => c.rank > 0);
  const trump: Suit | null = game.contract.strain !== 'NT' ? game.contract.strain : null;
  const hasBigHonors = hand.some((c) => c.rank >= 13 && c.suit !== trump);
  if (hasBigHonors && remainingTricks >= 2 && game.claim.claimedDeclarerTricks > currentDeclarerTricks + 1) {
    return false;
  }

  return true;
}

/**
 * Resolves the next bot action for a room if the current turn (or an active claim)
 * belongs to a bot-controlled seat.
 */
export function getNextBotAction(
  game: BotGameState,
  botSeats: Set<Seat>
): BotAction | null {
  if (game.phase === 'WAITING' || game.phase === 'FINISHED') {
    return null;
  }

  // Handle active claim response from a bot defender
  if (game.claim && !game.claim.rejectedRevealed && game.contract) {
    const declarerSide = sideOf(game.contract.declarer);
    for (const s of SEATS) {
      if (
        botSeats.has(s) &&
        sideOf(s) !== declarerSide &&
        !game.claim.acceptedBy.includes(s) &&
        !game.claim.rejectedBy.includes(s)
      ) {
        return {
          type: 'RESPOND_CLAIM',
          seat: s,
          accept: chooseBotClaimResponse(game, s),
        };
      }
    }
    return null;
  }

  if (game.phase === 'BIDDING') {
    const turnSeat = game.currentTurn;
    if (!botSeats.has(turnSeat)) return null;
    return {
      type: 'BID',
      seat: turnSeat,
      call: chooseBotBid(game, turnSeat),
    };
  }

  if (game.phase === 'PLAYING') {
    const turnSeat = game.currentTurn;
    // Dummy is played by declarer's side
    const controllerSeat: Seat =
      turnSeat === game.dummy && game.contract ? game.contract.declarer : turnSeat;

    if (!botSeats.has(controllerSeat)) return null;
    const card = chooseBotCard(game, turnSeat);
    if (!card) return null;
    return {
      type: 'PLAY_CARD',
      seat: turnSeat,
      card,
    };
  }

  return null;
}
