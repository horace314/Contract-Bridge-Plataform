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
  | { type: 'BID'; seat: Seat; call: BidCall; alerted?: boolean; explanation?: string }
  | { type: 'PLAY_CARD'; seat: Seat; card: Card }
  | { type: 'RESPOND_CLAIM'; seat: Seat; accept: boolean };

export interface BidDecision {
  call: BidCall;
  alerted?: boolean;
  explanation?: string;
}

export interface PimcConfig {
  /** Number of determinized worlds to sample per card decision */
  samples: number;
  /** Maximum remaining tricks for exact alpha-beta endgame search */
  exactEndgameTricks: number;
  /** Small random jitter (in expected tricks) to break near-ties naturally */
  tieBreakEpsilon: number;
  /** Optional custom RNG returning [0, 1) */
  rng?: () => number;
}

export const DEFAULT_PIMC_CONFIG: PimcConfig = {
  samples: 24,
  exactEndgameTricks: 4,
  tieBreakEpsilon: 0.02,
};

const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const STRAIN_ORDER: Strain[] = ['C', 'D', 'H', 'S', 'NT'];

export function sideOf(seat: Seat): 'NS' | 'EW' {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

export function partnerSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 2) % 4];
}

export function nextSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 1) % 4];
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

function cardKey(c: Card): string {
  return `${c.suit}:${c.rank}`;
}

function sameCard(a: Card, b: Card): boolean {
  return a.suit === b.suit && a.rank === b.rank;
}

// ============================================================================
// Hand Evaluation
// ============================================================================

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

export function getSuitHcp(cards: Card[]): Record<Suit, number> {
  const pts: Record<Suit, number> = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of cards) {
    if (c.rank <= 0 || pts[c.suit] === undefined) continue;
    if (c.rank === 14) pts[c.suit] += 4;
    else if (c.rank === 13) pts[c.suit] += 3;
    else if (c.rank === 12) pts[c.suit] += 2;
    else if (c.rank === 11) pts[c.suit] += 1;
  }
  return pts;
}

export interface HandEvaluation {
  hcp: number;
  lengthPoints: number;
  shortnessPoints: number;
  distPoints: number;
  totalPoints: number;
  lengths: Record<Suit, number>;
  suitHcp: Record<Suit, number>;
  isBalanced: boolean;
  hasShortness: boolean;
}

export function evaluateTotalPoints(
  cards: Card[],
  trumpFitSuit?: Suit | null
): HandEvaluation {
  const hcp = evaluateHighCardPoints(cards);
  const lengths = getSuitLengths(cards);
  const suitHcp = getSuitHcp(cards);
  const sortedLens = SUITS.map((s) => lengths[s]).sort((a, b) => b - a);
  const hasShortness = SUITS.some((s) => lengths[s] <= 1);

  let lengthPoints = 0;
  let shortnessPoints = 0;

  for (const s of SUITS) {
    const len = lengths[s];
    if (len >= 5) lengthPoints += len - 4;
    if (trumpFitSuit) {
      if (len === 0) shortnessPoints += 3;
      else if (len === 1) shortnessPoints += 2;
      else if (len === 2) shortnessPoints += 1;
    }
  }

  const isBalanced =
    !hasShortness &&
    sortedLens[3] >= 2 &&
    sortedLens[0] <= 5 &&
    !(sortedLens[0] === 5 && sortedLens[1] >= 4) &&
    sortedLens[0] !== 6;

  const distPoints = trumpFitSuit
    ? shortnessPoints
    : lengthPoints +
      SUITS.reduce((acc, s) => {
        const len = lengths[s];
        if (len === 0) return acc + 2;
        if (len === 1) return acc + 1;
        return acc;
      }, 0);

  return {
    hcp,
    lengthPoints,
    shortnessPoints,
    distPoints,
    totalPoints: hcp + distPoints,
    lengths,
    suitHcp,
    isBalanced,
    hasShortness,
  };
}

// ============================================================================
// Legal Bid Validation
// ============================================================================

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

// ============================================================================
// Bidding Engine (2/1 Game Forcing + Slam Conventions + System-On 1NT Overcall)
// ============================================================================

interface ContractBid {
  seat: Seat;
  level: number;
  strain: Strain;
}

interface AuctionContext {
  opener: Seat | null;
  openingContract: ContractBid | null;
  myContracts: { level: number; strain: Strain }[];
  partnerContracts: { level: number; strain: Strain }[];
  opponentContracts: ContractBid[];
  lastPartnerContract: { level: number; strain: Strain } | null;
  lastOpponentContract: ContractBid | null;
  opponent1NtBid: ContractBid | null;
  passedBeforePartnerOpened: boolean;
  isGameForceActive: boolean;
  agreedSuit: Suit | null;
  rkcAskedByPartner: boolean;
  rkcAskedByMe: boolean;
  partnerRkcResponse: { level: number; strain: Strain } | null;
}

function isTwoOverOneResponse(
  opening: { level: number; strain: Strain },
  response: { level: number; strain: Strain }
): boolean {
  if (opening.level !== 1 || opening.strain === 'NT') return false;
  if (response.level !== 2 || response.strain === 'NT') return false;
  return STRAIN_ORDER.indexOf(response.strain) < STRAIN_ORDER.indexOf(opening.strain);
}

function parseAuctionContext(auction: AuctionEntry[], seat: Seat): AuctionContext {
  const mySide = sideOf(seat);
  const pSeat = partnerSeat(seat);

  let opener: Seat | null = null;
  let openingContract: ContractBid | null = null;
  const myContracts: { level: number; strain: Strain }[] = [];
  const partnerContracts: { level: number; strain: Strain }[] = [];
  const opponentContracts: ContractBid[] = [];
  let opponent1NtBid: ContractBid | null = null;
  let passedBeforePartnerOpened = false;
  let seenMyPass = false;

  const sideSuits = new Set<Suit>();
  let agreedSuit: Suit | null = null;

  let rkcAskedByPartner = false;
  let rkcAskedByMe = false;
  let partnerRkcResponse: { level: number; strain: Strain } | null = null;

  for (const entry of auction) {
    if (entry.seat === seat && entry.call.type === 'PASS' && !opener) {
      seenMyPass = true;
    }
    if (entry.call.type === 'CONTRACT') {
      const bid: ContractBid = {
        seat: entry.seat,
        level: entry.call.level,
        strain: entry.call.strain,
      };
      if (!opener) {
        opener = entry.seat;
        openingContract = bid;
        if (entry.seat === pSeat && seenMyPass) {
          passedBeforePartnerOpened = true;
        }
      }

      if (sideOf(entry.seat) === mySide) {
        if (bid.strain !== 'NT') {
          if (sideSuits.has(bid.strain)) {
            agreedSuit = bid.strain;
          }
          sideSuits.add(bid.strain);
        }

        if (bid.level === 4 && bid.strain === 'NT' && !rkcAskedByPartner && !rkcAskedByMe) {
          if (entry.seat === pSeat) rkcAskedByPartner = true;
          else if (entry.seat === seat) rkcAskedByMe = true;
        } else if (rkcAskedByMe && entry.seat === pSeat && bid.level === 5 && !partnerRkcResponse) {
          partnerRkcResponse = { level: bid.level, strain: bid.strain };
        }
      }

      if (entry.seat === seat) {
        myContracts.push({ level: bid.level, strain: bid.strain });
      } else if (entry.seat === pSeat) {
        partnerContracts.push({ level: bid.level, strain: bid.strain });
      } else if (sideOf(entry.seat) !== mySide) {
        opponentContracts.push(bid);
        if (bid.level === 1 && bid.strain === 'NT') {
          opponent1NtBid = bid;
        }
      }
    }
  }

  let isGameForceActive = false;
  if (openingContract && sideOf(openingContract.seat) === mySide) {
    const responderFirst =
      openingContract.seat === seat ? partnerContracts[0] : myContracts[0];
    if (responderFirst && isTwoOverOneResponse(openingContract, responderFirst)) {
      isGameForceActive = true;
    }
    if (openingContract.level === 2 && openingContract.strain === 'C') {
      isGameForceActive = true;
    }
  }

  return {
    opener,
    openingContract,
    myContracts,
    partnerContracts,
    opponentContracts,
    lastPartnerContract:
      partnerContracts.length > 0 ? partnerContracts[partnerContracts.length - 1] : null,
    lastOpponentContract:
      opponentContracts.length > 0 ? opponentContracts[opponentContracts.length - 1] : null,
    opponent1NtBid,
    passedBeforePartnerOpened,
    isGameForceActive,
    agreedSuit,
    rkcAskedByPartner,
    rkcAskedByMe,
    partnerRkcResponse,
  };
}

function makeBid(
  isLegal: (call: BidCall) => boolean,
  level: number,
  strain: Strain,
  meta?: { alerted?: boolean; explanation?: string }
): BidDecision | null {
  if (level < 1 || level > 7) return null;
  const call: BidCall = { type: 'CONTRACT', level, strain };
  if (!isLegal(call)) return null;
  return { call, ...meta };
}

function makeBidOrLower(
  isLegal: (call: BidCall) => boolean,
  preferredLevel: number,
  strain: Strain,
  minLevel = 1,
  meta?: { alerted?: boolean; explanation?: string }
): BidDecision | null {
  for (let lvl = Math.min(preferredLevel, 7); lvl >= minLevel; lvl--) {
    const call: BidCall = { type: 'CONTRACT', level: lvl, strain };
    if (isLegal(call)) return { call, ...meta };
  }
  return null;
}

function selectBestSuit(
  lengths: Record<Suit, number>,
  suitHcp: Record<Suit, number>,
  excludedSuits: Set<Suit> = new Set(),
  minLength = 1,
  isLegal?: (call: BidCall) => boolean,
  level = 1
): Suit | null {
  let bestSuit: Suit | null = null;
  let bestScore = -Infinity;

  for (const s of SUITS) {
    if (excludedSuits.has(s)) continue;
    const len = lengths[s];
    if (len < minLength) continue;
    if (isLegal && !isLegal({ type: 'CONTRACT', level, strain: s })) continue;
    const majorBonus = s === 'S' || s === 'H' ? 0.5 : 0;
    const score = len * 10 + suitHcp[s] * 1.2 + majorBonus;
    if (score > bestScore) {
      bestScore = score;
      bestSuit = s;
    }
  }
  return bestSuit;
}

function hasSuitStopper(hand: Card[], suit: Suit): boolean {
  const cards = hand.filter((c) => c.suit === suit);
  if (cards.some((c) => c.rank === 14)) return true;
  if (cards.some((c) => c.rank === 13) && cards.length >= 2) return true;
  if (cards.some((c) => c.rank === 12) && cards.length >= 3) return true;
  if (cards.some((c) => c.rank === 11) && cards.length >= 4) return true;
  return false;
}

function countKeycards(hand: Card[], trump: Suit | null): {
  keycards: number;
  hasTrumpQueen: boolean;
} {
  let keycards = 0;
  for (const c of hand) {
    if (c.rank === 14) keycards += 1;
    else if (trump && c.suit === trump && c.rank === 13) keycards += 1;
  }
  const hasTrumpQueen = trump
    ? hand.some((c) => c.suit === trump && c.rank === 12)
    : false;
  return { keycards, hasTrumpQueen };
}

function bidRkcResponse(
  hand: Card[],
  trump: Suit | null,
  isLegal: (call: BidCall) => boolean
): BidDecision | null {
  const { keycards, hasTrumpQueen } = countKeycards(hand, trump);

  if (keycards === 1 || keycards === 4) {
    return makeBid(isLegal, 5, 'C', {
      alerted: true,
      explanation: `RKC 1430: ${keycards} keycard${keycards > 1 ? 's' : ''}`,
    });
  }
  if (keycards === 0 || keycards === 3) {
    return makeBid(isLegal, 5, 'D', {
      alerted: true,
      explanation: `RKC 1430: ${keycards} keycard${keycards === 3 ? 's' : ''}`,
    });
  }
  if (keycards === 2) {
    return hasTrumpQueen
      ? makeBid(isLegal, 5, 'S', {
          alerted: true,
          explanation: 'RKC 1430: 2 keycards + Trump Q',
        })
      : makeBid(isLegal, 5, 'H', {
          alerted: true,
          explanation: 'RKC 1430: 2 keycards, no Trump Q',
        });
  }
  return null;
}

function bidAfterRkcResponse(
  hand: Card[],
  trump: Suit | null,
  rkcResponse: { level: number; strain: Strain },
  isLegal: (call: BidCall) => boolean
): BidDecision | null {
  const myInfo = countKeycards(hand, trump);
  let partnerKeycards = 0;
  let partnerHasQ = false;

  if (rkcResponse.strain === 'C') {
    partnerKeycards = myInfo.keycards >= 3 ? 1 : 4;
  } else if (rkcResponse.strain === 'D') {
    partnerKeycards = myInfo.keycards >= 2 ? 0 : 3;
  } else if (rkcResponse.strain === 'H') {
    partnerKeycards = 2;
    partnerHasQ = false;
  } else if (rkcResponse.strain === 'S') {
    partnerKeycards = 2;
    partnerHasQ = true;
  }

  const totalKeycards = myInfo.keycards + partnerKeycards;
  const combinedHasQ = myInfo.hasTrumpQueen || partnerHasQ;
  const hcp = evaluateHighCardPoints(hand);

  if (totalKeycards < 4) {
    return trump
      ? makeBid(isLegal, 5, trump, { explanation: 'Missing keycards; sign off at 5' })
      : { call: { type: 'PASS' } };
  }

  if (totalKeycards >= 5 && (combinedHasQ || !trump) && hcp >= 18) {
    if (trump) {
      const grand = makeBid(isLegal, 7, trump, { explanation: 'All 5 keycards + Trump Q' });
      if (grand) return grand;
    } else {
      const grandNt = makeBid(isLegal, 7, 'NT', { explanation: 'Grand slam in NT' });
      if (grandNt) return grandNt;
    }
  }

  return trump
    ? makeBidOrLower(isLegal, 6, trump, 5, {
        explanation: `Small slam (${totalKeycards}/5 keycards)`,
      })
    : makeBidOrLower(isLegal, 6, 'NT', 5, {
        explanation: `Small slam in NT (${totalKeycards} keycards)`,
      });
}

function chooseOpeningBid(
  handEval: HandEvaluation,
  vulnerable: boolean,
  isLegal: (call: BidCall) => boolean,
  hasPartnerOpened = false
): BidDecision {
  const { hcp, lengths, isBalanced, totalPoints } = handEval;

  if (hcp >= 22) {
    const c2 = makeBid(isLegal, 2, 'C', {
      alerted: true,
      explanation: 'Strong artificial 2C (22+ HCP)',
    });
    if (c2) return c2;
  }

  if (!hasPartnerOpened && hcp >= 15 && hcp <= 17 && isBalanced) {
    const nt1 = makeBid(isLegal, 1, 'NT', { explanation: '15-17 HCP balanced' });
    if (nt1) return nt1;
  }

  if (totalPoints >= 12 || hcp >= 12) {
    if (lengths.S >= 5 && lengths.S >= lengths.H) {
      const s1 = makeBid(isLegal, 1, 'S');
      if (s1) return s1;
    }
    if (lengths.H >= 5 && lengths.H > lengths.S) {
      const h1 = makeBid(isLegal, 1, 'H');
      if (h1) return h1;
    }
    const minor: Suit =
      lengths.D > lengths.C ? 'D' : lengths.C > lengths.D ? 'C' : lengths.D >= 4 ? 'D' : 'C';
    const m1 = makeBid(isLegal, 1, minor);
    if (m1) return m1;
  }

  // Strictly weak-two openings: 6-card suit, 6-10 HCP (7-10 vulnerable), totalPoints < 12
  const minWeakHcp = vulnerable ? 7 : 6;
  if (totalPoints < 12 && hcp >= minWeakHcp && hcp <= 10) {
    for (const s of ['S', 'H', 'D'] as Suit[]) {
      const hasFourCardOtherMajor =
        (s === 'S' && lengths.H >= 4) || (s === 'H' && lengths.S >= 4);
      if (!hasFourCardOtherMajor && lengths[s] === 6 && handEval.suitHcp[s] >= 4) {
        const w2 = makeBid(isLegal, 2, s, {
          explanation: `Weak two (${minWeakHcp}-10 HCP, exact 6 ${s})`,
        });
        if (w2) return w2;
      }
    }
  }

  return { call: { type: 'PASS' } };
}

function chooseResponseTo1NT(
  handEval: HandEvaluation,
  isLegal: (call: BidCall) => boolean
): BidDecision {
  const { hcp, lengths, isBalanced } = handEval;

  if (isBalanced && hcp >= 18) {
    const slamNt = makeBid(isLegal, 6, 'NT', { explanation: 'Direct 6NT (18+ HCP balanced)' });
    if (slamNt) return slamNt;
  }
  if (isBalanced && hcp >= 16 && hcp <= 17) {
    const quant4Nt = makeBid(isLegal, 4, 'NT', {
      alerted: true,
      explanation: 'Quantitative 4NT (16-17 HCP balanced)',
    });
    if (quant4Nt) return quant4Nt;
  }
  if (lengths.S >= 5 && lengths.S >= lengths.H) {
    const xferS = makeBid(isLegal, 2, 'H', {
      alerted: true,
      explanation: 'Jacoby transfer to Spades (5+ S)',
    });
    if (xferS) return xferS;
  }
  if (lengths.H >= 5) {
    const xferH = makeBid(isLegal, 2, 'D', {
      alerted: true,
      explanation: 'Jacoby transfer to Hearts (5+ H)',
    });
    if (xferH) return xferH;
  }
  if (hcp >= 8 && (lengths.H >= 4 || lengths.S >= 4)) {
    const stayman = makeBid(isLegal, 2, 'C', {
      alerted: true,
      explanation: 'Stayman (4+ card major)',
    });
    if (stayman) return stayman;
  }
  if (hcp >= 10) {
    const nt3 = makeBid(isLegal, 3, 'NT');
    if (nt3) return nt3;
  }
  if (hcp >= 8) {
    const nt2 = makeBid(isLegal, 2, 'NT');
    if (nt2) return nt2;
  }
  return { call: { type: 'PASS' } };
}

function chooseResponseTo1Suit(
  hand: Card[],
  handEval: HandEvaluation,
  ctx: AuctionContext,
  oppSuits: Set<Suit>,
  isLegal: (call: BidCall) => boolean
): BidDecision {
  const pSuit = ctx.openingContract!.strain as Suit;
  const isMajorOpening = pSuit === 'H' || pSuit === 'S';
  const fitEval = evaluateTotalPoints(hand, pSuit);
  const supportLen = handEval.lengths[pSuit];
  const { hcp, lengths, suitHcp, isBalanced } = handEval;

  if (isMajorOpening && supportLen >= 4 && fitEval.totalPoints >= 13) {
    const gameRaise = makeBid(isLegal, 4, pSuit, {
      explanation: `Game raise (${fitEval.totalPoints} fit pts, ${supportLen}+ support)`,
    });
    if (gameRaise) return gameRaise;
  }

  if (
    isMajorOpening &&
    supportLen >= 3 &&
    ((fitEval.totalPoints >= 10 && fitEval.totalPoints <= 12) ||
      (supportLen >= 4 && hcp >= 10 && hcp <= 12))
  ) {
    const limitRaise = makeBid(isLegal, 3, pSuit, {
      explanation: `Limit raise (${fitEval.totalPoints} fit pts, ${supportLen}+ support)`,
    });
    if (limitRaise) return limitRaise;
  }

  if (isMajorOpening && supportLen >= 3 && (fitEval.totalPoints >= 6 || hcp >= 6)) {
    const singleRaise = makeBid(isLegal, 2, pSuit, {
      explanation: `Single raise (${fitEval.totalPoints} fit pts, ${supportLen}+ support)`,
    });
    if (singleRaise) return singleRaise;
  }

  if (hcp >= 6) {
    for (const maj of ['H', 'S'] as Suit[]) {
      if (maj !== pSuit && !oppSuits.has(maj) && lengths[maj] >= 4) {
        const b1Maj = makeBid(isLegal, 1, maj);
        if (b1Maj) return b1Maj;
      }
    }
  }

  const oneLevelSuit = selectBestSuit(
    lengths,
    suitHcp,
    new Set<Suit>([pSuit, ...oppSuits]),
    4,
    isLegal,
    1
  );
  if (oneLevelSuit && hcp >= 6) {
    const b1 = makeBid(isLegal, 1, oneLevelSuit);
    if (b1) return b1;
  }

  if (!ctx.passedBeforePartnerOpened && hcp >= 13) {
    const twoOverOneSuit = selectBestSuit(
      lengths,
      suitHcp,
      new Set<Suit>([pSuit, ...oppSuits]),
      4,
      isLegal,
      2
    );
    if (
      twoOverOneSuit &&
      STRAIN_ORDER.indexOf(twoOverOneSuit) < STRAIN_ORDER.indexOf(pSuit)
    ) {
      const gfBid = makeBid(isLegal, 2, twoOverOneSuit, {
        alerted: true,
        explanation: '2/1 Game Forcing (13+ HCP)',
      });
      if (gfBid) return gfBid;
    }
  }

  if (isMajorOpening && hcp >= 6 && hcp <= 12 && ctx.opponentContracts.length === 0) {
    const nt1Forcing = makeBid(isLegal, 1, 'NT', {
      alerted: !ctx.passedBeforePartnerOpened,
      explanation: ctx.passedBeforePartnerOpened
        ? 'Semi-forcing 1NT (6-11 HCP)'
        : '1NT Forcing (6-12 HCP)',
    });
    if (nt1Forcing) return nt1Forcing;
  }

  if (!isMajorOpening) {
    if (supportLen >= 4 && fitEval.totalPoints >= 6 && fitEval.totalPoints <= 9) {
      const minorRaise = makeBid(isLegal, 2, pSuit);
      if (minorRaise) return minorRaise;
    }
    if (hcp >= 13 && hcp <= 15 && isBalanced) {
      const nt3 = makeBid(isLegal, 3, 'NT');
      if (nt3) return nt3;
    }
    if (hcp >= 11 && hcp <= 12 && isBalanced) {
      const nt2 = makeBid(isLegal, 2, 'NT');
      if (nt2) return nt2;
    }
    if (hcp >= 6 && hcp <= 10 && isBalanced) {
      const nt1 = makeBid(isLegal, 1, 'NT');
      if (nt1) return nt1;
    }
  }

  return { call: { type: 'PASS' } };
}

function chooseOpenerRebid(
  hand: Card[],
  handEval: HandEvaluation,
  ctx: AuctionContext,
  oppSuits: Set<Suit>,
  isLegal: (call: BidCall) => boolean
): BidDecision {
  const myFirst = ctx.myContracts[0];
  const pResp = ctx.lastPartnerContract!;
  const { hcp, lengths, suitHcp, isBalanced } = handEval;

  if (myFirst.level === 2 && myFirst.strain === 'C') {
    if (isBalanced && hcp >= 22) {
      const ntBid = makeBidOrLower(isLegal, hcp >= 25 ? 3 : 2, 'NT', 2);
      if (ntBid) return ntBid;
    }
    const bestSuit = selectBestSuit(lengths, suitHcp, oppSuits, 5);
    if (bestSuit) {
      const suitBid = makeBidOrLower(isLegal, 2, bestSuit, 2);
      if (suitBid) return suitBid;
    }
    return makeBidOrLower(isLegal, 2, 'NT', 2) ?? { call: { type: 'PASS' } };
  }

  if (myFirst.strain === 'NT' && myFirst.level === 1) {
    const isMax = hcp >= 17;
    if (pResp.level === 4 && pResp.strain === 'NT') {
      if (hcp >= 17 || (hcp === 16 && lengths.S + lengths.H >= 7)) {
        const acc = makeBid(isLegal, 6, 'NT', { explanation: 'Accept quantitative 4NT' });
        if (acc) return acc;
      }
      return { call: { type: 'PASS' } };
    }
    if (pResp.level === 2 && pResp.strain === 'D') {
      const b = makeBidOrLower(isLegal, isMax && lengths.H >= 4 ? 3 : 2, 'H', 2, {
        explanation: isMax && lengths.H >= 4 ? 'Super-accept transfer to 3H' : 'Complete transfer to 2H',
      });
      if (b) return b;
    }
    if (pResp.level === 2 && pResp.strain === 'H') {
      const b = makeBidOrLower(isLegal, isMax && lengths.S >= 4 ? 3 : 2, 'S', 2, {
        explanation: isMax && lengths.S >= 4 ? 'Super-accept transfer to 3S' : 'Complete transfer to 2S',
      });
      if (b) return b;
    }
    if (pResp.level === 2 && pResp.strain === 'C') {
      if (lengths.H >= 4) {
        const b = makeBid(isLegal, 2, 'H');
        if (b) return b;
      }
      if (lengths.S >= 4) {
        const b = makeBid(isLegal, 2, 'S');
        if (b) return b;
      }
      const b = makeBid(isLegal, 2, 'D', { explanation: 'No 4-card major' });
      if (b) return b;
    }
    if (pResp.level === 2 && pResp.strain === 'NT' && isMax) {
      const b = makeBid(isLegal, 3, 'NT');
      if (b) return b;
    }
    return { call: { type: 'PASS' } };
  }

  if (myFirst.strain !== 'NT' && ctx.isGameForceActive) {
    const fitSuit: Suit | null =
      pResp.strain !== 'NT' && lengths[pResp.strain] >= 3
        ? pResp.strain
        : lengths[myFirst.strain] >= 6
        ? myFirst.strain
        : null;

    const fitEval = evaluateTotalPoints(hand, fitSuit);
    if ((fitEval.totalPoints >= 18 || hcp >= 18) && fitSuit) {
      const rkc = makeBid(isLegal, 4, 'NT', {
        alerted: true,
        explanation: 'RKC 1430 (slam interest after 2/1 GF)',
      });
      if (rkc) return rkc;
    }

    if (pResp.strain !== 'NT' && lengths[pResp.strain] >= 3) {
      const target = pResp.strain === 'H' || pResp.strain === 'S' ? 4 : 3;
      const raise = makeBidOrLower(isLegal, target, pResp.strain, pResp.level + 1);
      if (raise) return raise;
    }
    if (lengths[myFirst.strain] >= 6) {
      const rebid = makeBidOrLower(isLegal, myFirst.level + 1, myFirst.strain, myFirst.level + 1);
      if (rebid) return rebid;
    }
    if (isBalanced) {
      const ntBid = makeBidOrLower(isLegal, hcp >= 15 && hcp <= 17 ? 3 : 2, 'NT', 2);
      if (ntBid) return ntBid;
    }
    const sideSuit = selectBestSuit(
      lengths,
      suitHcp,
      new Set<Suit>([myFirst.strain, pResp.strain as Suit, ...oppSuits]),
      4
    );
    if (sideSuit) {
      const sideBid = makeBidOrLower(isLegal, 3, sideSuit, 2);
      if (sideBid) return sideBid;
    }
    return makeBidOrLower(isLegal, 3, 'NT', 2) ?? { call: { type: 'PASS' } };
  }

  if (
    (myFirst.strain === 'H' || myFirst.strain === 'S') &&
    pResp.level === 1 &&
    pResp.strain === 'NT'
  ) {
    if (lengths[myFirst.strain] >= 6) {
      const b = makeBidOrLower(isLegal, hcp >= 16 ? 3 : 2, myFirst.strain, 2);
      if (b) return b;
    }
    const secondSuit = selectBestSuit(
      lengths,
      suitHcp,
      new Set<Suit>([myFirst.strain, ...oppSuits]),
      4
    );
    if (secondSuit) {
      const b = makeBidOrLower(isLegal, hcp >= 17 ? 3 : 2, secondSuit, 2);
      if (b) return b;
    }
    const cheaperMinor: Suit = lengths.C >= lengths.D ? 'C' : 'D';
    return (
      makeBid(isLegal, 2, cheaperMinor, {
        explanation: 'Minor rebid after 1NT forcing',
      }) ?? { call: { type: 'PASS' } }
    );
  }

  if (myFirst.strain !== 'NT') {
    const fitEval = evaluateTotalPoints(hand, myFirst.strain);
    const pts = fitEval.totalPoints;

    if (pResp.strain !== 'NT' && lengths[pResp.strain] >= 3) {
      const target = pts >= 16 ? pResp.level + 2 : pts >= 12 ? pResp.level + 1 : 0;
      if (target > 0) {
        const r = makeBidOrLower(isLegal, target, pResp.strain, pResp.level + 1);
        if (r) return r;
      }
    }
    if (lengths[myFirst.strain] >= 6 && pts >= 12) {
      const target = pts >= 16 ? myFirst.level + 2 : myFirst.level + 1;
      const r = makeBidOrLower(isLegal, target, myFirst.strain, myFirst.level + 1);
      if (r) return r;
    }
    const secondSuit = selectBestSuit(
      lengths,
      suitHcp,
      new Set<Suit>([myFirst.strain, ...oppSuits]),
      4
    );
    if (secondSuit && pts >= 12) {
      const r = makeBidOrLower(isLegal, pts >= 17 ? 2 : 1, secondSuit, 1);
      if (r) return r;
    }
    if (isBalanced && hcp >= 12 && hcp <= 14) {
      const r = makeBid(isLegal, 1, 'NT');
      if (r) return r;
    }
    if (isBalanced && hcp >= 18 && hcp <= 19) {
      const r = makeBid(isLegal, 2, 'NT');
      if (r) return r;
    }
  }

  return { call: { type: 'PASS' } };
}

function chooseCompetitiveAction(
  hand: Card[],
  handEval: HandEvaluation,
  legal: ReturnType<typeof getLegalBidCalls>,
  ctx: AuctionContext,
  oppSuits: Set<Suit>
): BidDecision {
  const { hcp, lengths, suitHcp, isBalanced, totalPoints } = handEval;
  const { lastContract, canDouble, isLegal } = legal;

  if (ctx.lastOpponentContract) {
    const opp = ctx.lastOpponentContract;

    if (
      canDouble &&
      opp.strain !== 'NT' &&
      !ctx.opener &&
      !ctx.lastPartnerContract &&
      totalPoints >= 12 &&
      lengths[opp.strain] <= 2 &&
      opp.level <= 2
    ) {
      const unbidSuits = SUITS.filter((s) => s !== opp.strain);
      if (unbidSuits.some((s) => lengths[s] >= 3)) {
        return {
          call: { type: 'DOUBLE' },
          explanation: 'Takeout double (12+ pts, short in opponent suit)',
        };
      }
    }

    const overcallSuit = selectBestSuit(lengths, suitHcp, oppSuits, 5, isLegal, 1);
    if (
      overcallSuit &&
      (totalPoints >= 10 || (hcp >= 8 && hcp <= 16)) &&
      opp.level <= 2 &&
      suitHcp[overcallSuit] >= 3
    ) {
      const overcall = makeBidOrLower(isLegal, hcp >= 14 ? 2 : 1, overcallSuit, 1);
      if (overcall) return overcall;
    }

    if (
      isBalanced &&
      hcp >= 15 &&
      hcp <= 18 &&
      opp.level === 1 &&
      opp.strain !== 'NT' &&
      hasSuitStopper(hand, opp.strain)
    ) {
      const ntOvercall = makeBid(isLegal, 1, 'NT', {
        explanation: '15-18 HCP balanced NT overcall with stopper',
      });
      if (ntOvercall) return ntOvercall;
    }

    if (canDouble && hcp >= 14 && opp.level <= 3) {
      const hasStopper = opp.strain === 'NT' || hasSuitStopper(hand, opp.strain);
      if (!hasStopper || opp.level >= 2) {
        return { call: { type: 'DOUBLE' } };
      }
    }
  }

  if (canDouble && lastContract && hcp >= 15 && lastContract.level <= 2) {
    return { call: { type: 'DOUBLE' } };
  }

  return { call: { type: 'PASS' } };
}

export function chooseBotBidDetailed(game: BotGameState, seat: Seat): BidDecision {
  const hand = (game.hands[seat] || []).filter((c) => c.rank > 0);
  const vulnerable = isSeatVulnerable(game.vulnerability, seat);
  const handEval = evaluateTotalPoints(hand, null);
  const { hcp, lengths, isBalanced } = handEval;
  const legal = getLegalBidCalls(game.auction, seat);
  const { lastContract, isLegal } = legal;
  const ctx = parseAuctionContext(game.auction, seat);
  const pSeat = partnerSeat(seat);
  const oppSuits = new Set<Suit>(
    ctx.opponentContracts.map((c) => c.strain).filter((s): s is Suit => s !== 'NT')
  );

  const rkcTrump: Suit | null =
    ctx.agreedSuit ?? (lastContract && lastContract.strain !== 'NT' ? lastContract.strain : null);

  if (ctx.rkcAskedByPartner && !ctx.myContracts.some((c) => c.level >= 5)) {
    const resp = bidRkcResponse(hand, rkcTrump, isLegal);
    if (resp) return resp;
  }

  if (ctx.rkcAskedByMe && ctx.partnerRkcResponse) {
    const finalBid = bidAfterRkcResponse(hand, rkcTrump, ctx.partnerRkcResponse, isLegal);
    if (finalBid) return finalBid;
  }

  if (!lastContract && ctx.opener !== pSeat) {
    return chooseOpeningBid(handEval, vulnerable, isLegal, Boolean(ctx.opener));
  }

  if (
    ctx.opener === pSeat &&
    ctx.openingContract &&
    (ctx.openingContract.strain === 'H' || ctx.openingContract.strain === 'S') &&
    ctx.myContracts.some((c) => c.level === 1 && c.strain === 'NT') &&
    !ctx.myContracts.some((c) => c.strain === ctx.openingContract!.strain)
  ) {
    const pMajor = ctx.openingContract.strain;
    const fitEval = evaluateTotalPoints(hand, pMajor);
    if (lengths[pMajor] >= 4 && (hcp >= 13 || fitEval.totalPoints >= 14)) {
      const gameMajor = makeBid(isLegal, 4, pMajor, {
        explanation: `Game in ${pMajor} with ${lengths[pMajor]}-card fit (${fitEval.totalPoints} fit pts)`,
      });
      if (gameMajor) return gameMajor;
    }
  }

  if (
    ctx.myContracts.length === 1 &&
    ctx.myContracts[0].level === 2 &&
    (ctx.myContracts[0].strain === 'D' || ctx.myContracts[0].strain === 'H') &&
    ctx.lastPartnerContract &&
    ctx.lastPartnerContract.level >= 2 &&
    (ctx.lastPartnerContract.strain === 'H' || ctx.lastPartnerContract.strain === 'S')
  ) {
    const targetMajor: Suit = ctx.myContracts[0].strain === 'D' ? 'H' : 'S';
    const fitEval = evaluateTotalPoints(hand, targetMajor);
    if (fitEval.totalPoints >= 13) {
      const gameMajor = makeBid(isLegal, 4, targetMajor, {
        explanation: `Game in ${targetMajor} after transfer (${fitEval.totalPoints} pts)`,
      });
      if (gameMajor) return gameMajor;
    }
    if (fitEval.totalPoints >= 10) {
      const invMajor = makeBid(isLegal, 3, targetMajor, {
        explanation: `Invite in ${targetMajor} after transfer (${fitEval.totalPoints} pts)`,
      });
      if (invMajor) return invMajor;
    }
    return { call: { type: 'PASS' } };
  }

  if (
    ctx.opener === pSeat &&
    ctx.openingContract?.level === 2 &&
    ctx.openingContract?.strain === 'C' &&
    ctx.myContracts.length === 0
  ) {
    if (hcp >= 8) {
      const bestSuit = selectBestSuit(lengths, handEval.suitHcp, oppSuits, 5, isLegal, 2);
      if (bestSuit === 'S' || bestSuit === 'H') {
        const posM = makeBid(isLegal, 2, bestSuit, { explanation: 'Positive (8+ HCP, 5+ major)' });
        if (posM) return posM;
      }
      if (isBalanced) {
        const posNt = makeBid(isLegal, 2, 'NT', { explanation: 'Positive balanced (8+ HCP)' });
        if (posNt) return posNt;
      }
    }
    return (
      makeBid(isLegal, 2, 'D', {
        alerted: true,
        explanation: 'Waiting / negative over strong 2C',
      }) ?? { call: { type: 'PASS' } }
    );
  }

  const partnerOpenedNt =
    ctx.opener === pSeat &&
    ctx.openingContract?.strain === 'NT' &&
    (ctx.openingContract?.level === 1 || ctx.openingContract?.level === 2) &&
    ctx.myContracts.length === 0;
  const oppOvercalled1Nt =
    ctx.opponent1NtBid !== null &&
    lastContract?.level === 1 &&
    lastContract?.strain === 'NT' &&
    ctx.myContracts.length === 0 &&
    !ctx.lastPartnerContract;

  if (partnerOpenedNt || oppOvercalled1Nt) {
    return chooseResponseTo1NT(handEval, isLegal);
  }

  if (ctx.opener === seat && ctx.myContracts.length === 1 && ctx.lastPartnerContract) {
    return chooseOpenerRebid(hand, handEval, ctx, oppSuits, isLegal);
  }

  if (
    ctx.opener === pSeat &&
    ctx.openingContract?.level === 1 &&
    ctx.openingContract?.strain !== 'NT' &&
    ctx.myContracts.length === 0
  ) {
    if (
      ctx.passedBeforePartnerOpened &&
      ctx.lastPartnerContract?.strain === 'NT' &&
      lastContract?.strain === 'NT' &&
      lastContract?.level === 1
    ) {
      if (hcp >= 10 && isBalanced) {
        const nt2 = makeBid(isLegal, 2, 'NT');
        if (nt2) return nt2;
      }
      return { call: { type: 'PASS' } };
    }
    return chooseResponseTo1Suit(hand, handEval, ctx, oppSuits, isLegal);
  }

  if (ctx.isGameForceActive && ctx.opener === pSeat && ctx.myContracts.length >= 1) {
    const openerLast = ctx.lastPartnerContract;
    const slamSuit: Suit | null =
      openerLast && openerLast.strain !== 'NT' && lengths[openerLast.strain] >= 3
        ? openerLast.strain
        : ctx.agreedSuit;
    const fitEval = evaluateTotalPoints(hand, slamSuit);

    if (fitEval.totalPoints >= 18 || (isBalanced && hcp >= 19)) {
      const rkc = makeBid(isLegal, 4, 'NT', {
        alerted: true,
        explanation: 'RKC 1430 (slam try in 2/1 GF)',
      });
      if (rkc) return rkc;
    }

    if (
      openerLast &&
      (openerLast.strain === 'H' || openerLast.strain === 'S') &&
      lengths[openerLast.strain] >= 3
    ) {
      const raise = makeBidOrLower(isLegal, 4, openerLast.strain, openerLast.level + 1);
      if (raise) return raise;
    }
    if (isBalanced) {
      const nt3 = makeBidOrLower(isLegal, 3, 'NT', 2);
      if (nt3) return nt3;
    }
    const myFirstSuit = ctx.myContracts[0].strain;
    if (myFirstSuit !== 'NT' && lengths[myFirstSuit] >= 6) {
      const rebid = makeBidOrLower(isLegal, 4, myFirstSuit, 3);
      if (rebid) return rebid;
    }
  }

  if (
    ctx.opener === pSeat &&
    ctx.myContracts.length === 1 &&
    ctx.myContracts[0].level === 1 &&
    ctx.myContracts[0].strain === 'NT' &&
    ctx.openingContract &&
    (ctx.openingContract.strain === 'H' || ctx.openingContract.strain === 'S')
  ) {
    const pMajor = ctx.openingContract.strain;
    const fitEval = evaluateTotalPoints(hand, pMajor);
    if (lengths[pMajor] >= 4 && (hcp >= 13 || fitEval.totalPoints >= 14)) {
      const gameMajor = makeBid(isLegal, 4, pMajor, {
        explanation: `Game in ${pMajor} with ${lengths[pMajor]}-card fit`,
      });
      if (gameMajor) return gameMajor;
    }
    if (lengths[pMajor] >= 3 && fitEval.totalPoints >= 10) {
      const invRaise = makeBidOrLower(isLegal, 3, pMajor, 3, {
        explanation: '3-card limit raise (10-12 pts)',
      });
      if (invRaise) return invRaise;
    }
    if (lengths[pMajor] >= 2) {
      const pref = makeBid(isLegal, 2, pMajor);
      if (pref) return pref;
    }
    if (isBalanced && hcp >= 11) {
      const nt2 = makeBid(isLegal, 2, 'NT');
      if (nt2) return nt2;
    }
    return { call: { type: 'PASS' } };
  }

  return chooseCompetitiveAction(hand, handEval, legal, ctx, oppSuits);
}

export function chooseBotBid(game: BotGameState, seat: Seat): BidCall {
  return chooseBotBidDetailed(game, seat).call;
}

// ============================================================================
// Trick Mechanics, PIMC Card Play & Claim Handling
// ============================================================================

function getLegalCards(hand: Card[], currentTrick: { seat: Seat; card: Card }[]): Card[] {
  if (currentTrick.length === 0) return hand;
  const leadSuit = currentTrick[0].card.suit;
  const following = hand.filter((c) => c.suit === leadSuit);
  return following.length > 0 ? following : hand;
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

interface KnownInformation {
  knownHands: Partial<Record<Seat, Card[]>>;
  remainingCounts: Record<Seat, number>;
  unseenPool: Card[];
  shownVoids: Record<Seat, Set<Suit>>;
}

function buildKnownInformation(game: BotGameState, actingSeat: Seat): KnownInformation {
  const seenKeys = new Set<string>();
  const playedCount: Record<Seat, number> = { N: 0, E: 0, S: 0, W: 0 };
  const shownVoids: Record<Seat, Set<Suit>> = {
    N: new Set(),
    E: new Set(),
    S: new Set(),
    W: new Set(),
  };

  for (const trick of game.tricksHistory) {
    if (trick.cards.length === 0) continue;
    const leadSuit = trick.cards[0].card.suit;
    for (const play of trick.cards) {
      seenKeys.add(cardKey(play.card));
      playedCount[play.seat] += 1;
      if (play.card.suit !== leadSuit) {
        shownVoids[play.seat].add(leadSuit);
      }
    }
  }

  if (game.currentTrick.length > 0) {
    const leadSuit = game.currentTrick[0].card.suit;
    for (const play of game.currentTrick) {
      seenKeys.add(cardKey(play.card));
      playedCount[play.seat] += 1;
      if (play.card.suit !== leadSuit) {
        shownVoids[play.seat].add(leadSuit);
      }
    }
  }

  const knownHands: Partial<Record<Seat, Card[]>> = {};
  const openingLeadMade = game.tricksHistory.length > 0 || game.currentTrick.length > 0;

  const visibleSeats = new Set<Seat>([actingSeat]);
  if (game.dummy && openingLeadMade) {
    visibleSeats.add(game.dummy);
  }
  if (game.dummy && actingSeat === game.dummy && game.contract) {
    visibleSeats.add(game.contract.declarer);
  }

  for (const s of visibleSeats) {
    const cards = (game.hands[s] || []).filter((c) => c.rank > 0);
    if (cards.length > 0 || playedCount[s] === 13) {
      knownHands[s] = [...cards];
      for (const c of cards) {
        seenKeys.add(cardKey(c));
      }
    }
  }

  const remainingCounts: Record<Seat, number> = {
    N: Math.max(0, 13 - playedCount.N),
    E: Math.max(0, 13 - playedCount.E),
    S: Math.max(0, 13 - playedCount.S),
    W: Math.max(0, 13 - playedCount.W),
  };

  for (const s of Object.keys(knownHands) as Seat[]) {
    remainingCounts[s] = knownHands[s]!.length;
  }

  const unseenPool: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      const c: Card = { suit, rank };
      if (!seenKeys.has(cardKey(c))) {
        unseenPool.push(c);
      }
    }
  }

  return { knownHands, remainingCounts, unseenPool, shownVoids };
}

function sampleWorld(
  info: KnownInformation,
  rng: () => number
): Record<Seat, Card[]> {
  const hiddenSeats = SEATS.filter((s) => info.knownHands[s] === undefined);

  for (let attempt = 0; attempt < 15; attempt++) {
    const pool = [...info.unseenPool];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    const world: Partial<Record<Seat, Card[]>> = {};
    for (const s of SEATS) {
      world[s] = info.knownHands[s] !== undefined ? [...info.knownHands[s]!] : [];
    }

    let valid = true;
    const used = new Array<boolean>(pool.length).fill(false);
    const orderedHidden = [...hiddenSeats].sort(
      (a, b) => info.shownVoids[b].size - info.shownVoids[a].size
    );

    for (const s of orderedHidden) {
      const needed = info.remainingCounts[s];
      const voids = info.shownVoids[s];
      let taken = 0;

      for (let i = 0; i < pool.length && taken < needed; i++) {
        if (!used[i] && !voids.has(pool[i].suit)) {
          used[i] = true;
          world[s]!.push(pool[i]);
          taken++;
        }
      }

      if (taken < needed) {
        valid = false;
        break;
      }
    }

    if (valid) {
      return world as Record<Seat, Card[]>;
    }
  }

  const pool = [...info.unseenPool];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const world: Record<Seat, Card[]> = { N: [], E: [], S: [], W: [] };
  let idx = 0;
  for (const s of SEATS) {
    if (info.knownHands[s] !== undefined) {
      world[s] = [...info.knownHands[s]!];
    } else {
      const needed = info.remainingCounts[s];
      world[s] = pool.slice(idx, idx + needed);
      idx += needed;
    }
  }
  return world;
}

function chooseFastTacticalCard(
  hands: Record<Seat, Card[]>,
  seat: Seat,
  trick: { seat: Seat; card: Card }[],
  trump: Suit | null
): Card {
  const hand = hands[seat];
  const legal = getLegalCards(hand, trick);
  if (legal.length === 1) return legal[0];

  if (trick.length === 0) {
    const sortedDesc = [...legal].sort((a, b) => b.rank - a.rank);
    const nonTrump = trump ? sortedDesc.filter((c) => c.suit !== trump) : sortedDesc;
    const pool = nonTrump.length > 0 ? nonTrump : sortedDesc;

    const lengths = getSuitLengths(pool);
    let bestSuit = pool[0].suit;
    let bestLen = -1;
    for (const c of pool) {
      if (lengths[c.suit] > bestLen) {
        bestLen = lengths[c.suit];
        bestSuit = c.suit;
      }
    }
    const suitCards = pool.filter((c) => c.suit === bestSuit).sort((a, b) => b.rank - a.rank);
    if (suitCards.length >= 2 && suitCards[0].rank - suitCards[1].rank === 1) {
      return suitCards[0];
    }
    return suitCards[Math.min(3, suitCards.length - 1)];
  }

  const leadSuit = trick[0].card.suit;
  const following = hand.filter((c) => c.suit === leadSuit);
  const currentWinner = getTrickWinnerSeat(trick, trump);
  const partnerWinning = sideOf(currentWinner) === sideOf(seat);

  let bestCard = trick[0].card;
  for (let i = 1; i < trick.length; i++) {
    if (cardBeats(trick[i].card, bestCard, trump)) {
      bestCard = trick[i].card;
    }
  }

  if (trick.length === 1 && following.length > 0) {
    return [...following].sort((a, b) => a.rank - b.rank)[0];
  }

  if (partnerWinning) {
    if (following.length > 0) {
      return [...following].sort((a, b) => a.rank - b.rank)[0];
    }
    const nonTrump = trump ? legal.filter((c) => c.suit !== trump) : legal;
    const discardPool = nonTrump.length > 0 ? nonTrump : legal;
    return [...discardPool].sort((a, b) => a.rank - b.rank)[0];
  }

  const winners = legal
    .filter((c) => cardBeats(c, bestCard, trump))
    .sort((a, b) => a.rank - b.rank);
  if (winners.length > 0) return winners[0];

  if (following.length === 0 && trump) {
    const nonTrump = legal.filter((c) => c.suit !== trump).sort((a, b) => a.rank - b.rank);
    if (nonTrump.length > 0) return nonTrump[0];
  }
  return [...legal].sort((a, b) => a.rank - b.rank)[0];
}

function removeCard(hand: Card[], target: Card): Card[] {
  const idx = hand.findIndex((c) => sameCard(c, target));
  if (idx === -1) return hand;
  const copy = hand.slice();
  copy.splice(idx, 1);
  return copy;
}

function pruneEquivalentMoves(legal: Card[], allHands: Record<Seat, Card[]>): Card[] {
  if (legal.length <= 1) return legal;

  const remainingRanksBySuit: Record<Suit, number[]> = { S: [], H: [], D: [], C: [] };
  for (const s of SEATS) {
    for (const c of allHands[s]) {
      remainingRanksBySuit[c.suit].push(c.rank);
    }
  }
  for (const suit of SUITS) {
    remainingRanksBySuit[suit].sort((a, b) => a - b);
  }

  const sorted = [...legal].sort((a, b) => a.suit.localeCompare(b.suit) || a.rank - b.rank);
  const pruned: Card[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    if (i === 0 || sorted[i - 1].suit !== cur.suit) {
      pruned.push(cur);
      continue;
    }
    const prev = sorted[i - 1];
    const suitRanks = remainingRanksBySuit[cur.suit];
    const prevIdx = suitRanks.indexOf(prev.rank);
    const curIdx = suitRanks.indexOf(cur.rank);
    if (curIdx !== prevIdx + 1) {
      pruned.push(cur);
    }
  }
  return pruned;
}

function evaluateDeterminizedState(
  hands: Record<Seat, Card[]>,
  turn: Seat,
  trick: { seat: Seat; card: Card }[],
  trump: Suit | null,
  targetSide: 'NS' | 'EW',
  exactEndgameTricks: number
): number {
  const remainingTricks = hands[turn].length + (trick.length > 0 ? 1 : 0);
  if (remainingTricks === 0) return 0;

  if (remainingTricks > exactEndgameTricks) {
    const card = chooseFastTacticalCard(hands, turn, trick, trump);
    const nextHands: Record<Seat, Card[]> = {
      ...hands,
      [turn]: removeCard(hands[turn], card),
    };
    const nextTrick = [...trick, { seat: turn, card }];

    if (nextTrick.length === 4) {
      const winner = getTrickWinnerSeat(nextTrick, trump);
      const gain = sideOf(winner) === targetSide ? 1 : 0;
      return (
        gain +
        evaluateDeterminizedState(nextHands, winner, [], trump, targetSide, exactEndgameTricks)
      );
    }
    return evaluateDeterminizedState(
      nextHands,
      nextSeat(turn),
      nextTrick,
      trump,
      targetSide,
      exactEndgameTricks
    );
  }

  function alphaBeta(
    curHands: Record<Seat, Card[]>,
    curTurn: Seat,
    curTrick: { seat: Seat; card: Card }[],
    alpha: number,
    beta: number
  ): number {
    if (curHands[curTurn].length === 0) return 0;

    const isMax = sideOf(curTurn) === targetSide;
    const legal = pruneEquivalentMoves(getLegalCards(curHands[curTurn], curTrick), curHands);
    legal.sort((a, b) => b.rank - a.rank);

    if (isMax) {
      let best = -1;
      for (const card of legal) {
        const nextHands: Record<Seat, Card[]> = {
          ...curHands,
          [curTurn]: removeCard(curHands[curTurn], card),
        };
        const nextTrick = [...curTrick, { seat: curTurn, card }];

        let score: number;
        if (nextTrick.length === 4) {
          const winner = getTrickWinnerSeat(nextTrick, trump);
          const gain = sideOf(winner) === targetSide ? 1 : 0;
          score = gain + alphaBeta(nextHands, winner, [], alpha - gain, beta - gain);
        } else {
          score = alphaBeta(nextHands, nextSeat(curTurn), nextTrick, alpha, beta);
        }

        if (score > best) best = score;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    } else {
      let best = 14;
      for (const card of legal) {
        const nextHands: Record<Seat, Card[]> = {
          ...curHands,
          [curTurn]: removeCard(curHands[curTurn], card),
        };
        const nextTrick = [...curTrick, { seat: curTurn, card }];

        let score: number;
        if (nextTrick.length === 4) {
          const winner = getTrickWinnerSeat(nextTrick, trump);
          const gain = sideOf(winner) === targetSide ? 1 : 0;
          score = gain + alphaBeta(nextHands, winner, [], alpha - gain, beta - gain);
        } else {
          score = alphaBeta(nextHands, nextSeat(curTurn), nextTrick, alpha, beta);
        }

        if (score < best) best = score;
        if (best < beta) beta = best;
        if (alpha >= beta) break;
      }
      return best;
    }
  }

  return alphaBeta(hands, turn, trick, -1, 14);
}

export function chooseBotCard(
  game: BotGameState,
  actingSeat: Seat,
  config: PimcConfig = DEFAULT_PIMC_CONFIG
): Card | null {
  const hand = (game.hands[actingSeat] || []).filter((c) => c.rank > 0);
  if (hand.length === 0) return null;

  const legalCards = getLegalCards(hand, game.currentTrick);
  if (legalCards.length === 1) return legalCards[0];

  const trump: Suit | null =
    game.contract && game.contract.strain !== 'NT' ? game.contract.strain : null;
  const targetSide = sideOf(actingSeat);
  const rng = config.rng ?? Math.random;

  const info = buildKnownInformation(game, actingSeat);
  const candidateScores = new Map<string, { card: Card; totalTricks: number }>();
  for (const c of legalCards) {
    candidateScores.set(cardKey(c), { card: c, totalTricks: 0 });
  }

  const sampleCount = Math.max(1, config.samples);

  for (let s = 0; s < sampleCount; s++) {
    const world = sampleWorld(info, rng);
    world[actingSeat] = [...hand];

    for (const c of legalCards) {
      const nextHands: Record<Seat, Card[]> = {
        ...world,
        [actingSeat]: removeCard(world[actingSeat], c),
      };
      const nextTrick = [...game.currentTrick, { seat: actingSeat, card: c }];

      let expectedTricks: number;
      if (nextTrick.length === 4) {
        const winner = getTrickWinnerSeat(nextTrick, trump);
        const gain = sideOf(winner) === targetSide ? 1 : 0;
        expectedTricks =
          gain +
          evaluateDeterminizedState(
            nextHands,
            winner,
            [],
            trump,
            targetSide,
            config.exactEndgameTricks
          );
      } else {
        expectedTricks = evaluateDeterminizedState(
          nextHands,
          nextSeat(actingSeat),
          nextTrick,
          trump,
          targetSide,
          config.exactEndgameTricks
        );
      }

      candidateScores.get(cardKey(c))!.totalTricks += expectedTricks;
    }
  }

  let bestCard = legalCards[0];
  let bestScore = -Infinity;

  for (const entry of candidateScores.values()) {
    const avgTricks = entry.totalTricks / sampleCount;
    const jitter = config.tieBreakEpsilon > 0 ? rng() * config.tieBreakEpsilon : 0;
    const score = avgTricks + jitter;
    if (score > bestScore) {
      bestScore = score;
      bestCard = entry.card;
    }
  }

  return bestCard;
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

  const hand = (game.hands[defenderSeat] || []).filter((c) => c.rank > 0);
  const trump: Suit | null = game.contract.strain !== 'NT' ? game.contract.strain : null;
  const hasBigHonors = hand.some((c) => c.rank >= 13 && c.suit !== trump);
  if (
    hasBigHonors &&
    remainingTricks >= 2 &&
    game.claim.claimedDeclarerTricks > currentDeclarerTricks + 1
  ) {
    return false;
  }

  return true;
}

export function getNextBotAction(
  game: BotGameState,
  botSeats: Set<Seat>,
  pimcConfig: PimcConfig = DEFAULT_PIMC_CONFIG
): BotAction | null {
  if (game.phase === 'WAITING' || game.phase === 'FINISHED') {
    return null;
  }

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
    const decision = chooseBotBidDetailed(game, turnSeat);
    return {
      type: 'BID',
      seat: turnSeat,
      call: decision.call,
      alerted: decision.alerted,
      explanation: decision.explanation,
    };
  }

  if (game.phase === 'PLAYING') {
    const turnSeat = game.currentTurn;
    const controllerSeat: Seat =
      turnSeat === game.dummy && game.contract ? game.contract.declarer : turnSeat;

    if (!botSeats.has(controllerSeat)) return null;
    const card = chooseBotCard(game, turnSeat, pimcConfig);
    if (!card) return null;
    return {
      type: 'PLAY_CARD',
      seat: turnSeat,
      card,
    };
  }

  return null;
}