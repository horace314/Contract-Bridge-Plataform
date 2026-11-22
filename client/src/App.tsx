import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Seat = 'N' | 'E' | 'S' | 'W';
type Suit = 'C' | 'D' | 'H' | 'S';
type Strain = Suit | 'NT';

interface Card {
  suit: Suit;
  rank: number;
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

interface GameState {
  boardNumber: number;
  dealer: Seat;
  vulnerability: 'NONE' | 'NS' | 'EW' | 'BOTH';
  phase: 'WAITING' | 'BIDDING' | 'PLAYING' | 'FINISHED';
  hands: Partial<Record<Seat, Card[]>>;
  initialHands?: Partial<Record<Seat, Card[]>>;
  auction: AuctionEntry[];
  contract: { level: number; strain: Strain; declarer: Seat; doubled: 0 | 1 | 2 } | null;
  dummy: Seat | null;
  currentTurn: Seat;
  currentTrick: { seat: Seat; card: Card }[];
  tricksHistory: { winner: Seat; cards: { seat: Seat; card: Card }[] }[];
  tricksWon: { NS: number; EW: number };
  score: { NS: number; EW: number } | null;
  claim: ClaimState | null;
  acceptedClaim?: AcceptedClaimRecord | null;
}

interface CompletedTrickRecord {
  winner: Seat;
  cards: { seat: Seat; card: Card }[];
}

interface CompletedBoardRecord {
  id: number;
  board_number: number;
  dealer?: string;
  vulnerability?: string;
  contract_text: string | null;
  declarer: string | null;
  tricks_ns: number;
  tricks_ew: number;
  score_ns: number;
  score_ew: number;
  tricks_history?: CompletedTrickRecord[];
  initial_hands?: Partial<Record<Seat, Card[]>>;
  auction?: AuctionEntry[];
  accepted_claim?: AcceptedClaimRecord | null;
  pbn: string;
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const STRAIN_ORDER: Strain[] = ['C', 'D', 'H', 'S', 'NT'];
const SEAT_FULL_NAME: Record<Seat, string> = {
  N: 'North',
  E: 'East',
  S: 'South',
  W: 'West',
};
const SUIT_SYM: Record<Strain, string> = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT' };
const RANK_SYM: Record<number, string> = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10' };

function rankLabel(rank: number): string {
  return RANK_SYM[rank] || String(rank);
}

function sideOf(seat: Seat): 'NS' | 'EW' {
  return seat === 'N' || seat === 'S' ? 'NS' : 'EW';
}

function partnerSeat(seat: Seat): Seat {
  return SEATS[(SEATS.indexOf(seat) + 2) % 4];
}

function isRedStrain(strain: Strain): boolean {
  return strain === 'H' || strain === 'D';
}

function isRedSuit(suit: Suit): boolean {
  return suit === 'H' || suit === 'D';
}

function getSuitOrderForContract(strain: Strain | null | undefined): Suit[] {
  const defaultOrder: Suit[] = ['S', 'H', 'C', 'D'];
  if (!strain || strain === 'NT') {
    return defaultOrder;
  }
  const trump = strain as Suit;
  const trumpIsRed = isRedSuit(trump);
  const remaining = defaultOrder.filter((s) => s !== trump);

  const ordered: Suit[] = [trump];
  let expectRed = !trumpIsRed;
  const pool = [...remaining];

  while (pool.length > 0) {
    const matchIdx = pool.findIndex((s) => isRedSuit(s) === expectRed);
    if (matchIdx !== -1) {
      ordered.push(pool[matchIdx]);
      pool.splice(matchIdx, 1);
    } else {
      ordered.push(pool[0]);
      pool.splice(0, 1);
    }
    expectRed = !expectRed;
  }

  return ordered;
}

function sortCardsBySuitOrder(cards: Card[], suitOrder: Suit[]): Card[] {
  const rankInOrder = (s: Suit) => {
    const idx = suitOrder.indexOf(s);
    return idx === -1 ? suitOrder.length : idx;
  };
  return [...cards].sort((a, b) => {
    const sa = rankInOrder(a.suit);
    const sb = rankInOrder(b.suit);
    if (sa !== sb) return sa - sb;
    return b.rank - a.rank;
  });
}

function parseHandsFromPbn(pbn: string): Partial<Record<Seat, Card[]>> {
  const dealMatch = pbn.match(/\[Deal\s+"([NESW]):([^"]+)"\]/i);
  if (!dealMatch) return {};
  const startSeat = dealMatch[1].toUpperCase() as Seat;
  const startIdx = SEATS.indexOf(startSeat);
  const handChunks = dealMatch[2].trim().split(/\s+/);
  const rankMap: Record<string, number> = {
    A: 14, K: 13, Q: 12, J: 11, T: 10,
    '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
  };
  const suitOrder: Suit[] = ['S', 'H', 'D', 'C'];
  const result: Partial<Record<Seat, Card[]>> = {};

  handChunks.forEach((hStr, idx) => {
    const seat = SEATS[(startIdx + idx) % 4];
    const suitParts = hStr.split('.');
    const cards: Card[] = [];
    suitParts.forEach((part, sIdx) => {
      const suit = suitOrder[sIdx];
      if (!suit || !part) return;
      for (const ch of part) {
        const r = rankMap[ch.toUpperCase()];
        if (r) cards.push({ suit, rank: r });
      }
    });
    result[seat] = cards;
  });
  return result;
}

function parseTricksFromPbn(pbn: string): CompletedTrickRecord[] {
  const playMatch = pbn.match(/\[Play\s+"([^"]+)"\]/i);
  if (!playMatch) return [];
  const tokens = playMatch[1].trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const suitMap: Record<string, Suit> = {
    S: 'S', H: 'H', D: 'D', C: 'C',
    s: 'S', h: 'H', d: 'D', c: 'C',
  };
  const rankMap: Record<string, number> = {
    A: 14, K: 13, Q: 12, J: 11, T: 10,
    '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
  };

  const seatMatch = pbn.match(/\[PlaySeat\s+"([NESW])"\]/i);
  let leader: Seat = (seatMatch?.[1]?.toUpperCase() as Seat) || 'N';

  const parsedCards: { seat: Seat; card: Card }[] = [];
  for (const tok of tokens) {
    if (tok === '-' || tok.length < 2) continue;
    const s = suitMap[tok[0]];
    const r = rankMap[tok[1]];
    if (!s || !r) continue;
    const playSeat = SEATS[(SEATS.indexOf(leader) + (parsedCards.length % 4)) % 4];
    parsedCards.push({ seat: playSeat, card: { suit: s, rank: r } });
    if (parsedCards.length % 4 === 0) {
      const chunk = parsedCards.slice(-4);
      const leadSuit = chunk[0].card.suit;
      let winIdx = 0;
      for (let i = 1; i < chunk.length; i++) {
        if (chunk[i].card.suit === leadSuit && chunk[i].card.rank > chunk[winIdx].card.rank) {
          winIdx = i;
        }
      }
      leader = chunk[winIdx].seat;
    }
  }

  const tricks: CompletedTrickRecord[] = [];
  for (let i = 0; i < parsedCards.length; i += 4) {
    const chunk = parsedCards.slice(i, i + 4);
    if (chunk.length === 0) continue;
    const leadSuit = chunk[0].card.suit;
    let winIdx = 0;
    for (let j = 1; j < chunk.length; j++) {
      if (chunk[j].card.suit === leadSuit && chunk[j].card.rank > chunk[winIdx].card.rank) {
        winIdx = j;
      }
    }
    const winner = chunk[winIdx].seat;
    tricks.push({ winner, cards: chunk });
  }
  return tricks;
}

function formatContractAndResult(board: CompletedBoardRecord): {
  contractLabel: string;
  resultLabel: string;
  compactResult: string;
} {
  if (!board.contract_text || board.contract_text === 'Pass') {
    return { contractLabel: 'Pass', resultLabel: 'Passed Out', compactResult: 'Pass' };
  }

  const levelMatch = board.contract_text.match(/^([1-7])(C|D|H|S|NT)(XX|X)?$/);
  if (!levelMatch) {
    return {
      contractLabel: board.contract_text,
      resultLabel: '-',
      compactResult: board.contract_text,
    };
  }

  const level = Number(levelMatch[1]);
  const strain = levelMatch[2] as Strain;
  const doubledSuffix = levelMatch[3] || '';
  const sym = SUIT_SYM[strain];
  const bySeat = board.declarer ? ` ${board.declarer}` : '';
  const contractLabel = `${level}${sym}${doubledSuffix}${bySeat}`;

  const declSide =
    board.declarer === 'N' || board.declarer === 'S' ? 'NS' : 'EW';
  const tricksMade = declSide === 'NS' ? board.tricks_ns : board.tricks_ew;
  const target = 6 + level;
  const diff = tricksMade - target;

  const resultLabel = diff === 0 ? '=' : diff > 0 ? `+${diff}` : `-${Math.abs(diff)}`;
  const compactResult = `${level}${sym}${doubledSuffix}${board.declarer || ''}${resultLabel}`;

  return { contractLabel, resultLabel, compactResult };
}

function getAuctionLegalStatus(
  auction: { seat: Seat; call: BidCall }[],
  seat: Seat
): {
  lastContract: { level: number; strain: Strain } | null;
  canDouble: boolean;
  canRedouble: boolean;
  isLevelLegal: (level: number) => boolean;
  isStrainLegal: (level: number, strain: Strain) => boolean;
} {
  let lastContractEntry: { seat: Seat; level: number; strain: Strain } | null = null;
  let doubled: 0 | 1 | 2 = 0;

  for (const item of auction) {
    if (item.call.type === 'CONTRACT') {
      lastContractEntry = { seat: item.seat, level: item.call.level, strain: item.call.strain };
      doubled = 0;
    } else if (item.call.type === 'DOUBLE') {
      doubled = 1;
    } else if (item.call.type === 'REDOUBLE') {
      doubled = 2;
    }
  }

  const isStrainLegal = (level: number, strain: Strain): boolean => {
    if (level < 1 || level > 7) return false;
    if (!lastContractEntry) return true;
    if (level !== lastContractEntry.level) return level > lastContractEntry.level;
    return STRAIN_ORDER.indexOf(strain) > STRAIN_ORDER.indexOf(lastContractEntry.strain);
  };

  const isLevelLegal = (level: number): boolean => {
    return STRAIN_ORDER.some((st) => isStrainLegal(level, st));
  };

  const canDouble = Boolean(
    lastContractEntry && doubled === 0 && sideOf(lastContractEntry.seat) !== sideOf(seat)
  );
  const canRedouble = Boolean(
    lastContractEntry && doubled === 1 && sideOf(lastContractEntry.seat) === sideOf(seat)
  );

  return {
    lastContract: lastContractEntry
      ? { level: lastContractEntry.level, strain: lastContractEntry.strain }
      : null,
    canDouble,
    canRedouble,
    isLevelLegal,
    isStrainLegal,
  };
}

function renderColoredBidCall(call: BidCall) {
  if (call.type === 'PASS') return <span className="bid-text-black">Pass</span>;
  if (call.type === 'DOUBLE') return <span className="bid-text-black">X</span>;
  if (call.type === 'REDOUBLE') return <span className="bid-text-black">XX</span>;
  const red = isRedStrain(call.strain);
  return (
    <span className="bid-text-black">
      {call.level}
      <span className={red ? 'suit-red' : 'suit-black'}>{SUIT_SYM[call.strain]}</span>
    </span>
  );
}

function getBoardBadgeSpec(boardNumber: number) {
  const dealers: Seat[] = ['N', 'E', 'S', 'W'];
  const vuls: ('NONE' | 'NS' | 'EW' | 'BOTH')[] = [
    'NONE', 'NS', 'EW', 'BOTH',
    'NS', 'EW', 'BOTH', 'NONE',
    'EW', 'BOTH', 'NONE', 'NS',
    'BOTH', 'NONE', 'NS', 'EW',
  ];
  const idx = ((boardNumber - 1) % 16 + 16) % 16;
  return {
    dealer: dealers[(boardNumber - 1) % 4],
    vul: vuls[idx],
  };
}

function FanCardBack({
  orientation,
  count,
}: {
  orientation: 'top' | 'left' | 'right';
  count: number;
}) {
  return (
    <div className={`felt-back-fan felt-back-${orientation}`} aria-label={`${count} cards`}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="felt-back-strip" />
      ))}
    </div>
  );
}

function StripCardFace({
  card,
  disabled,
  onClick,
  highlighted,
}: {
  card: Card;
  disabled?: boolean;
  onClick?: () => void;
  highlighted?: boolean;
}) {
  const red = isRedSuit(card.suit);
  const sym = SUIT_SYM[card.suit];
  const lbl = rankLabel(card.rank);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`felt-strip-card ${red ? 'suit-red' : 'suit-black'} ${
        !disabled && onClick ? 'playable' : ''
      } ${highlighted ? 'highlighted' : ''}`}
      title={`${lbl}${sym}`}
    >
      <span className="felt-strip-rank">{lbl}</span>
      <span className="felt-strip-pip">{sym}</span>
    </button>
  );
}

function HorizontalSuitHand({
  cards,
  canPlayCard,
  onPlayCard,
  mode,
  suitOrder,
}: {
  cards: Card[];
  canPlayCard: (c: Card) => boolean;
  onPlayCard: (c: Card) => void;
  mode: 'declarer-dummy' | 'defender-dummy';
  suitOrder: Suit[];
}) {
  const grouped = suitOrder
    .map((suit) => ({
      suit,
      cards: cards
        .filter((c) => c.suit === suit && c.rank > 0)
        .sort((a, b) => b.rank - a.rank),
    }))
    .filter((g) => g.cards.length > 0);

  if (mode === 'declarer-dummy') {
    const flatSorted = grouped.flatMap((g) => g.cards);
    return (
      <div className="declarer-dummy-strip">
        {flatSorted.map((card, i) => {
          const red = isRedSuit(card.suit);
          const sym = SUIT_SYM[card.suit];
          const lbl = rankLabel(card.rank);
          const playable = canPlayCard(card);
          return (
            <button
              key={`${card.suit}-${card.rank}-${i}`}
              type="button"
              disabled={!playable}
              onClick={() => onPlayCard(card)}
              className={`declarer-dummy-card ${red ? 'suit-red' : 'suit-black'} ${
                playable ? 'playable' : ''
              }`}
              title={`${lbl}${sym}`}
            >
              <span className="declarer-dummy-rank">{lbl}</span>
              <span className="declarer-dummy-pip">{sym}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="defender-dummy-rows">
      {grouped.map((group) => (
        <div key={group.suit} className="defender-dummy-row">
          {group.cards.map((card, i) => {
            const red = isRedSuit(card.suit);
            const sym = SUIT_SYM[card.suit];
            const lbl = rankLabel(card.rank);
            const playable = canPlayCard(card);
            return (
              <button
                key={`${card.suit}-${card.rank}-${i}`}
                type="button"
                disabled={!playable}
                onClick={() => onPlayCard(card)}
                className={`defender-row-card ${red ? 'suit-red' : 'suit-black'} ${
                  playable ? 'playable' : ''
                }`}
                title={`${lbl}${sym}`}
              >
                <span className="defender-row-rank">{lbl}</span>
                <span className="defender-row-pip">{sym}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CenterTrickCard({ card }: { card: Card }) {
  const red = isRedSuit(card.suit);
  const sym = SUIT_SYM[card.suit];
  const lbl = rankLabel(card.rank);
  const isTen = lbl === '10';
  return (
    <div className={`felt-trick-card ${red ? 'suit-red' : 'suit-black'}`}>
      <div className={`felt-trick-top ${isTen ? 'is-ten' : ''}`}>
        <span>{lbl}</span>
        <span>{sym}</span>
      </div>
      <div className="felt-trick-center">{sym}</div>
      <div className={`felt-trick-bottom ${isTen ? 'is-ten' : ''}`}>
        <span>{lbl}</span>
        <span>{sym}</span>
      </div>
    </div>
  );
}

function HoverTrickCardPicture({ card }: { card: Card }) {
  const red = isRedSuit(card.suit);
  const sym = SUIT_SYM[card.suit];
  const lbl = rankLabel(card.rank);
  return (
    <div className="hover-pic-card">
      <span className="hover-pic-rank bid-text-black">{lbl}</span>
      <span className={`hover-pic-pip ${red ? 'suit-red' : 'suit-black'}`}>{sym}</span>
    </div>
  );
}

function ReplaySuitHandBox({
  seat,
  label,
  cards,
  playedSet,
  highlightTop,
}: {
  seat: Seat;
  label: string;
  cards: Card[];
  playedSet: Set<string>;
  highlightTop?: boolean;
}) {
  const suits: Suit[] = ['S', 'H', 'D', 'C'];
  return (
    <div className="replay-hand-box">
      <div className={`replay-hand-header ${highlightTop ? 'is-highlight' : ''}`}>
        <span className="replay-seat-badge">{seat}</span>
        <span className="replay-seat-name">{label}</span>
      </div>
      <div className="replay-hand-suits">
        {suits.map((suit) => {
          const suitCards = cards
            .filter((c) => c.suit === suit)
            .sort((a, b) => b.rank - a.rank);
          const red = isRedSuit(suit);
          return (
            <div key={suit} className="replay-suit-line">
              <span className={`replay-suit-sym ${red ? 'suit-red' : 'suit-black'}`}>
                {SUIT_SYM[suit]}
              </span>
              <span className="replay-suit-ranks">
                {suitCards.length === 0 ? (
                  <span className="replay-void-dash">—</span>
                ) : (
                  suitCards.map((c, idx) => {
                    const key = `${c.suit}-${c.rank}`;
                    const isPlayed = playedSet.has(key);
                    return (
                      <span
                        key={`${key}-${idx}`}
                        className={`replay-rank-token bid-text-black ${
                          isPlayed ? 'is-played' : ''
                        }`}
                      >
                        {rankLabel(c.rank)}
                      </span>
                    );
                  })
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [tableId, setTableId] = useState('main-room');
  const [selectedSeat, setSelectedSeat] = useState<Seat>('S');
  const [playerNameInput, setPlayerNameInput] = useState(() => {
    return localStorage.getItem('bridge_player_name') || '';
  });
  const [seatNames, setSeatNames] = useState<Partial<Record<Seat, string>>>({});
  const [mySeat, setMySeat] = useState<Seat | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [displayedTrick, setDisplayedTrick] = useState<{ seat: Seat; card: Card }[]>([]);
  const [selectedBidLevel, setSelectedBidLevel] = useState<number | null>(null);
  const [explainingBidIndex, setExplainingBidIndex] = useState<number | null>(null);
  const [explanationInput, setExplanationInput] = useState('');
  const [hoveredBidPopover, setHoveredBidPopover] = useState<{
    key: string;
    partnerName: string;
    partnerSeat: Seat;
    explanation: string;
    top: number;
    left: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [history, setHistory] = useState<CompletedBoardRecord[]>([]);
  const [selectedBoardPreview, setSelectedBoardPreview] = useState<number>(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [scoreModalOpen, setScoreModalOpen] = useState(false);
  const [cumulativeScore, setCumulativeScore] = useState<{ NS: number; EW: number }>({
    NS: 0,
    EW: 0,
  });
  const [lastScoredBoardId, setLastScoredBoardId] = useState<number | null>(null);
  const [hoverBoardPopup, setHoverBoardPopup] = useState(false);
  const [hoverContractPopup, setHoverContractPopup] = useState(false);
  const [hoverLastTrickPopup, setHoverLastTrickPopup] = useState(false);
  const [animatedTrickCount, setAnimatedTrickCount] = useState(0);
  const [claimModalOpen, setClaimModalOpen] = useState(false);
  const [claimTricksInput, setClaimTricksInput] = useState<number>(1);
  const [historyModalBoard, setHistoryModalBoard] = useState<CompletedBoardRecord | null>(null);
  const [historyViewMode, setHistoryViewMode] = useState<'bidding' | 'play'>('bidding');
  const [selectedTrickIdx, setSelectedTrickIdx] = useState<number>(0);
  const [revealedCardStep, setRevealedCardStep] = useState<number>(4);
  const [showClaimSummary, setShowClaimSummary] = useState<boolean>(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const chatOpenRef = useRef(chatOpen);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    chatOpenRef.current = chatOpen;
    if (chatOpen) {
      setUnreadChatCount(0);
      setTimeout(() => {
        chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 30);
    }
  }, [chatOpen]);

  useEffect(() => {
    if (chatOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, chatOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (hoveredBidPopover) {
        setHoveredBidPopover(null);
        return;
      }
      if (explainingBidIndex !== null) {
        setExplainingBidIndex(null);
        setExplanationInput('');
        return;
      }
      if (claimModalOpen) {
        setClaimModalOpen(false);
        return;
      }
      if (historyModalBoard) {
        setHistoryModalBoard(null);
        return;
      }
      if (drawerOpen) {
        setDrawerOpen(false);
        return;
      }
      if (scoreModalOpen) {
        setScoreModalOpen(false);
        return;
      }
      if (chatOpen) {
        setChatOpen(false);
        return;
      }
      setHoverBoardPopup(false);
      setHoverContractPopup(false);
      setHoverLastTrickPopup(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    hoveredBidPopover,
    explainingBidIndex,
    claimModalOpen,
    historyModalBoard,
    drawerOpen,
    scoreModalOpen,
    chatOpen,
  ]);

  useEffect(() => {
    const s = io(SERVER_URL);
    setSocket(s);

    s.on('connect', () => {
      setConnected(true);
      setErrorMsg('');
    });

    s.on('disconnect', () => {
      setConnected(false);
    });

    s.on('connect_error', () => {
      setConnected(false);
      setErrorMsg(`Cannot reach Bridge server at ${SERVER_URL}. Start server on port 3001.`);
    });

    s.on('table_state', (payload) => {
      if (payload.reconnectToken && payload.mySeat) {
        localStorage.setItem(`bridge_token_${tableId}_${payload.mySeat}`, payload.reconnectToken);
      }
      if (payload.seatNames) {
        setSeatNames(payload.seatNames);
      }
      if (Array.isArray(payload.chatMessages)) {
        setChatMessages(payload.chatMessages);
      }
      if (payload.playerName) {
        setPlayerNameInput(payload.playerName);
        localStorage.setItem('bridge_player_name', payload.playerName);
      }
      setMySeat(payload.mySeat);
      const nextGame: GameState = payload.game;
      setGame(nextGame);

      if (nextGame.currentTrick.length > 0) {
        setDisplayedTrick(nextGame.currentTrick);
      } else if (nextGame.tricksHistory.length === 0) {
        setDisplayedTrick([]);
      } else if (nextGame.phase === 'FINISHED') {
        setDisplayedTrick(nextGame.tricksHistory[nextGame.tricksHistory.length - 1].cards);
      } else if (nextGame.tricksHistory.length > 0) {
        setDisplayedTrick(nextGame.tricksHistory[nextGame.tricksHistory.length - 1].cards);
      }

      if (nextGame?.boardNumber) {
        setSelectedBoardPreview(nextGame.boardNumber);
      }
      setErrorMsg('');
    });

    s.on('chat_message', (msg: ChatMessage) => {
      setChatMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
      if (!chatOpenRef.current) {
        setUnreadChatCount((c) => c + 1);
      }
    });

    s.on('error_msg', (msg: string) => {
      setErrorMsg(msg);
    });

    return () => {
      s.disconnect();
    };
  }, []);

  // Build replay entries capped at accepted claim when one exists
  const modalAcceptedClaim: AcceptedClaimRecord | null = historyModalBoard?.accepted_claim ?? null;
  const rawTricks: CompletedTrickRecord[] = historyModalBoard
    ? historyModalBoard.tricks_history && historyModalBoard.tricks_history.length > 0
      ? historyModalBoard.tricks_history
      : parseTricksFromPbn(historyModalBoard.pbn || '')
    : [];

  const claimCutoffTrickIdx = (() => {
    if (!modalAcceptedClaim) return null;
    if (typeof modalAcceptedClaim.acceptedAtTrickNumber === 'number' && modalAcceptedClaim.acceptedAtTrickNumber > 0) {
      return Math.max(0, modalAcceptedClaim.acceptedAtTrickNumber - 1);
    }
    return null;
  })();

  const claimCutoffCardStep = (() => {
    if (!modalAcceptedClaim) return null;
    if (typeof modalAcceptedClaim.acceptedAtCardIndex === 'number' && modalAcceptedClaim.acceptedAtCardIndex >= 0) {
      return modalAcceptedClaim.acceptedAtCardIndex;
    }
    return null;
  })();

  const modalTricks: CompletedTrickRecord[] = (() => {
    if (!historyModalBoard) return [];
    if (modalAcceptedClaim) {
      const limitTrickCount =
        claimCutoffTrickIdx !== null
          ? Math.min(rawTricks.length, claimCutoffTrickIdx + 1)
          : modalAcceptedClaim.completedTricksCount;
      const capped = rawTricks.slice(0, limitTrickCount);
      if (modalAcceptedClaim.partialTrick && modalAcceptedClaim.partialTrick.length > 0) {
        const lastIsPartial =
          capped.length > 0 &&
          capped[capped.length - 1].cards.length === modalAcceptedClaim.partialTrick.length &&
          capped[capped.length - 1].cards.every(
            (c, idx) =>
              c.seat === modalAcceptedClaim.partialTrick[idx].seat &&
              c.card.suit === modalAcceptedClaim.partialTrick[idx].card.suit &&
              c.card.rank === modalAcceptedClaim.partialTrick[idx].card.rank
          );
        if (!lastIsPartial) {
          capped.push({
            winner: modalAcceptedClaim.claimedBy,
            cards: modalAcceptedClaim.partialTrick,
          });
        }
      }
      return capped;
    }
    return rawTricks;
  })();

  useEffect(() => {
    if (!historyModalBoard) {
      setShowClaimSummary(false);
    }
  }, [historyModalBoard]);

  const lastTrick =
    game && game.tricksHistory.length > 0
      ? game.tricksHistory[game.tricksHistory.length - 1]
      : null;

  useEffect(() => {
    if (!hoverLastTrickPopup || !lastTrick || lastTrick.cards.length === 0) {
      setAnimatedTrickCount(0);
      return;
    }

    setAnimatedTrickCount(1);
    const total = lastTrick.cards.length;
    if (total <= 1) return;

    let step = 1;
    const interval = setInterval(() => {
      step += 1;
      setAnimatedTrickCount(step);
      if (step >= total) {
        clearInterval(interval);
      }
    }, 360);

    return () => clearInterval(interval);
  }, [hoverLastTrickPopup, lastTrick]);

  const loadHistory = async (room: string) => {
    try {
      const res = await fetch(`${SERVER_URL}/api/boards/${encodeURIComponent(room)}`);
      const data = await res.json();
      const rows: CompletedBoardRecord[] = data.boards || [];
      setHistory(rows);
      const totals = rows.reduce(
        (acc, b) => ({
          NS: acc.NS + Number(b.score_ns || 0),
          EW: acc.EW + Number(b.score_ew || 0),
        }),
        { NS: 0, EW: 0 }
      );
      setCumulativeScore(totals);
    } catch {
      // Ignore if endpoint unreachable
    }
  };

  useEffect(() => {
    loadHistory(tableId);
  }, [tableId]);

  useEffect(() => {
    if (game?.phase === 'FINISHED' && game.score) {
      const key = game.boardNumber * 100000 + Math.abs(game.score.NS);
      if (lastScoredBoardId !== key) {
        setLastScoredBoardId(key);
        setCumulativeScore((prev) => ({
          NS: prev.NS + game.score!.NS,
          EW: prev.EW + game.score!.EW,
        }));
      }
      loadHistory(tableId);
    }
  }, [game?.phase, game?.score, game?.boardNumber, tableId, lastScoredBoardId]);

  const joinSeat = (seat: Seat) => {
    if (!socket) return;
    const trimmedName = playerNameInput.trim() || `Player ${seat}`;
    localStorage.setItem('bridge_player_name', trimmedName);
    const tokenKey = `bridge_token_${tableId}_${seat}`;
    const reconnectToken = localStorage.getItem(tokenKey) || undefined;
    socket.emit('join_table', {
      tableId,
      seat,
      playerName: trimmedName,
      reconnectToken,
    });
    setDrawerOpen(false);
  };

  const sendBid = (call: BidCall) => {
    socket?.emit('make_bid', { tableId, call });
    setSelectedBidLevel(null);
  };

  const alertPartnerBidCall = (bidIndex: number) => {
    socket?.emit('alert_bid', { tableId, bidIndex });
  };

  const askForExplanation = (bidIndex: number) => {
    socket?.emit('request_explanation', { tableId, bidIndex });
  };

  const openPartnerExplainModal = (bidIndex: number, existingExplanation?: string) => {
    setExplainingBidIndex(bidIndex);
    setExplanationInput(existingExplanation || '');
  };

  const submitPartnerExplanation = (alsoAlert: boolean) => {
    if (explainingBidIndex === null) return;
    if (alsoAlert) {
      socket?.emit('alert_bid', {
        tableId,
        bidIndex: explainingBidIndex,
        explanation: explanationInput.trim() || undefined,
      });
    } else {
      socket?.emit('explain_bid', {
        tableId,
        bidIndex: explainingBidIndex,
        explanation: explanationInput.trim(),
      });
    }
    setExplainingBidIndex(null);
    setExplanationInput('');
  };

  const sendCard = (card: Card) => {
    socket?.emit('play_card', { tableId, card });
  };

  const submitClaim = () => {
    socket?.emit('claim_tricks', { tableId, claimedTricks: claimTricksInput });
    setClaimModalOpen(false);
  };

  const respondClaim = (accept: boolean) => {
    socket?.emit('respond_claim', { tableId, accept });
  };

  const sendChatMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || !socket) return;
    socket.emit('send_chat', { tableId, text: trimmed });
    setChatInput('');
  };

  const nextBoard = () => {
    setDisplayedTrick([]);
    socket?.emit('next_board', { tableId });
  };

  const isMyTurn = Boolean(
    game &&
      mySeat &&
      !(game.claim && !game.claim.rejectedRevealed) &&
      (game.currentTurn === mySeat ||
        (game.phase === 'PLAYING' &&
          game.currentTurn === game.dummy &&
          game.contract?.declarer === mySeat))
  );

  const activeHandSeat: Seat | null =
    game && mySeat
      ? game.phase === 'PLAYING' &&
        game.currentTurn === game.dummy &&
        game.contract?.declarer === mySeat
        ? game.dummy
        : mySeat
      : null;

  const isDeclarer = Boolean(game && mySeat && game.contract?.declarer === mySeat);
  const declarerSide = game?.contract ? sideOf(game.contract.declarer) : null;
  const isDefender = Boolean(
    game && mySeat && declarerSide && sideOf(mySeat) !== declarerSide
  );
  const canDeclarerClaim = Boolean(
    game?.phase === 'PLAYING' &&
      isDeclarer &&
      (!game.claim || game.claim.rejectedRevealed)
  );

  const currentDeclarerTricks =
    game && declarerSide ? game.tricksWon[declarerSide] : 0;
  const remainingTricks = game
    ? 13 - (game.tricksWon.NS + game.tricksWon.EW)
    : 13;
  const maxClaimableTricks = currentDeclarerTricks + remainingTricks;

  const bottomSeat: Seat = mySeat || 'S';
  const topSeat: Seat =
    bottomSeat === 'S' ? 'N' : bottomSeat === 'N' ? 'S' : bottomSeat === 'E' ? 'W' : 'E';
  const leftSeat: Seat =
    bottomSeat === 'S' ? 'W' : bottomSeat === 'N' ? 'E' : bottomSeat === 'E' ? 'S' : 'N';
  const rightSeat: Seat =
    bottomSeat === 'S' ? 'E' : bottomSeat === 'N' ? 'W' : bottomSeat === 'E' ? 'N' : 'S';

  const visualSlotForSeat = (seat: Seat): 'top' | 'bottom' | 'left' | 'right' => {
    if (seat === bottomSeat) return 'bottom';
    if (seat === topSeat) return 'top';
    if (seat === leftSeat) return 'left';
    return 'right';
  };

  const isDeclarerOrDummyViewer = Boolean(
    game &&
      mySeat &&
      (game.contract?.declarer === mySeat || game.dummy === mySeat)
  );

  const isOpponentOfDeclarerOrDummy = (seat: Seat): boolean =>
    Boolean(isDeclarerOrDummyViewer && mySeat && sideOf(seat) !== sideOf(mySeat));

  const dummyModeForSeat = (seat: Seat): 'declarer-dummy' | 'defender-dummy' => {
    if (game?.phase === 'FINISHED' && isOpponentOfDeclarerOrDummy(seat)) {
      return 'defender-dummy';
    }
    if (game?.dummy === seat && isDefender) {
      return 'defender-dummy';
    }
    if (
      isDefender &&
      game?.contract?.declarer === seat &&
      Boolean(game?.claim || game?.acceptedClaim)
    ) {
      return 'defender-dummy';
    }
    return 'declarer-dummy';
  };

  const contractSuitOrder = getSuitOrderForContract(game?.contract?.strain);
  const bottomCards = sortCardsBySuitOrder(game?.hands[bottomSeat] || [], contractSuitOrder);
  const isClaimRevealed = Boolean(
    game?.claim || game?.acceptedClaim || game?.phase === 'FINISHED'
  );
  const topCards = game?.hands[topSeat] || [];
  const topIsFaceUp = topCards.some((c) => c.rank > 0);
  const leftCards = game?.hands[leftSeat] || [];
  const leftIsFaceUp = leftCards.some((c) => c.rank > 0);
  const rightCards = game?.hands[rightSeat] || [];
  const rightIsFaceUp = rightCards.some((c) => c.rank > 0);
  const previewSpec = getBoardBadgeSpec(selectedBoardPreview);

  const displayNameForSeat = (seat: Seat) => {
    if (seatNames[seat]) return seatNames[seat]!;
    if (mySeat === seat && playerNameInput.trim()) return playerNameInput.trim();
    return `${SEAT_FULL_NAME[seat]} Seat`;
  };

  const formatSeatLabel = (seat: Seat) => {
    const nm = displayNameForSeat(seat);
    if (mySeat === seat) return `${nm} (You)`;
    if (game?.dummy === seat) return `${nm} · Dummy`;
    return nm;
  };

  const turnDisplayLabel = game
    ? `${displayNameForSeat(game.currentTurn)} (${game.currentTurn})`
    : '';

  const auctionStatus =
    game && mySeat
      ? getAuctionLegalStatus(game.auction, mySeat)
      : {
          lastContract: null,
          canDouble: false,
          canRedouble: false,
          isLevelLegal: () => false,
          isStrainLegal: () => false,
        };

  interface AuctionCellItem {
    entry: AuctionEntry;
    bidIndex: number;
  }

  const auctionCols: Seat[] = ['W', 'N', 'E', 'S'];
  const auctionRows: (AuctionCellItem | null)[][] = [];
  if (game) {
    const startIdx = auctionCols.indexOf(game.dealer);
    const flat: (AuctionCellItem | null)[] = Array(startIdx).fill(null);
    game.auction.forEach((entry, bidIndex) => {
      flat.push({ entry, bidIndex });
    });
    while (flat.length % 4 !== 0) {
      flat.push(null);
    }
    for (let i = 0; i < flat.length; i += 4) {
      auctionRows.push(flat.slice(i, i + 4));
    }
  }

  const pendingPartnerExplainRequests: { entry: AuctionEntry; bidIndex: number }[] =
    game && mySeat
      ? game.auction
          .map((entry, bidIndex) => ({ entry, bidIndex }))
          .filter(
            ({ entry }) =>
              partnerSeat(entry.seat) === mySeat &&
              (entry.explanationRequestedBy?.length || 0) > 0 &&
              !entry.explanation
          )
      : [];

  const openBidHoverPopover = (
    el: HTMLElement,
    key: string,
    bidderSeat: Seat,
    explanation: string
  ) => {
    const rect = el.getBoundingClientRect();
    const pSeat = partnerSeat(bidderSeat);
    setHoveredBidPopover({
      key,
      partnerName: displayNameForSeat(pSeat),
      partnerSeat: pSeat,
      explanation,
      top: rect.top,
      left: rect.left + rect.width / 2,
    });
  };

  const renderAuctionCellContent = (cell: AuctionCellItem | null, scopeKey: string) => {
    if (!cell) return null;
    const { entry, bidIndex } = cell;
    const hoverId = `${scopeKey}-${bidIndex}`;
    const isPartner = Boolean(mySeat && partnerSeat(entry.seat) === mySeat);
    const isOpponent = Boolean(mySeat && sideOf(entry.seat) !== sideOf(mySeat));
    const hasRequested = Boolean(mySeat && entry.explanationRequestedBy?.includes(mySeat));
    const anyOpponentAsked = (entry.explanationRequestedBy?.length || 0) > 0;
    const hasExplanation = Boolean(entry.explanation);

    return (
      <div
        className={`auction-bid-wrapper ${entry.alerted ? 'is-alerted' : ''} ${
          anyOpponentAsked && !hasExplanation ? 'needs-explanation' : ''
        }`}
        onMouseEnter={(e) => {
          if (hasExplanation && entry.explanation) {
            openBidHoverPopover(e.currentTarget, hoverId, entry.seat, entry.explanation);
          }
        }}
        onMouseLeave={() => {
          setHoveredBidPopover((prev) => (prev?.key === hoverId ? null : prev));
        }}
        onClick={(e) => {
          if (hasExplanation && entry.explanation) {
            e.stopPropagation();
            const target = e.currentTarget;
            setHoveredBidPopover((prev) => {
              if (prev?.key === hoverId) return null;
              const rect = target.getBoundingClientRect();
              const pSeat = partnerSeat(entry.seat);
              return {
                key: hoverId,
                partnerName: displayNameForSeat(pSeat),
                partnerSeat: pSeat,
                explanation: entry.explanation!,
                top: rect.top,
                left: rect.left + rect.width / 2,
              };
            });
          }
        }}
      >
        <div className="auction-bid-main">
          {renderColoredBidCall(entry.call)}
          {entry.alerted && (
            <span className="bid-alert-badge" title="Alerted by partner">
              !
            </span>
          )}
          {hasExplanation && (
            <span className="bid-explained-badge" title="Hover to view explanation">
              ?
            </span>
          )}
        </div>

        {(game?.phase === 'BIDDING' || game?.phase === 'PLAYING') && isPartner && (
          <div className="bid-cell-actions">
            {!entry.alerted && (
              <button
                type="button"
                className="bid-mini-btn bid-alert-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  alertPartnerBidCall(bidIndex);
                }}
                title="Alert partner's bid"
              >
                Alert
              </button>
            )}
            <button
              type="button"
              className={`bid-mini-btn bid-explain-btn ${
                anyOpponentAsked && !hasExplanation ? 'urgent' : ''
              }`}
              onClick={(e) => {
                e.stopPropagation();
                openPartnerExplainModal(bidIndex, entry.explanation);
              }}
              title="Explain partner's bid"
            >
              {hasExplanation ? 'Edit' : anyOpponentAsked ? 'Explain!' : 'Explain'}
            </button>
          </div>
        )}

        {(game?.phase === 'BIDDING' || game?.phase === 'PLAYING') &&
          isOpponent &&
          !hasExplanation && (
            <div className="bid-cell-actions">
              <button
                type="button"
                className="bid-mini-btn bid-ask-btn"
                disabled={hasRequested}
                onClick={(e) => {
                  e.stopPropagation();
                  askForExplanation(bidIndex);
                }}
                title="Ask bidder's partner to explain this bid"
              >
                {hasRequested ? 'Asked' : 'Ask?'}
              </button>
            </div>
          )}
      </div>
    );
  };

  // Helper to resolve initial hands & auction for a board in history modal
  const modalHands: Partial<Record<Seat, Card[]>> = historyModalBoard
    ? historyModalBoard.initial_hands &&
      Object.keys(historyModalBoard.initial_hands).length > 0
      ? historyModalBoard.initial_hands
      : game && game.boardNumber === historyModalBoard.board_number && game.initialHands
      ? game.initialHands
      : parseHandsFromPbn(historyModalBoard.pbn || '')
    : {};

  const modalAuction: AuctionEntry[] = historyModalBoard
    ? historyModalBoard.auction && historyModalBoard.auction.length > 0
      ? historyModalBoard.auction
      : game && game.boardNumber === historyModalBoard.board_number
      ? game.auction
      : []
    : [];

  const modalDealer: Seat = (historyModalBoard?.dealer as Seat) || 'N';
  const modalVul = historyModalBoard?.vulnerability || 'NONE';

  const modalAuctionRows: (AuctionEntry | null)[][] = (() => {
    const startIdx = auctionCols.indexOf(modalDealer);
    const flat: (AuctionEntry | null)[] = Array(startIdx).fill(null);
    modalAuction.forEach((entry) => flat.push(entry));
    while (flat.length % 4 !== 0) flat.push(null);
    const rows: (AuctionEntry | null)[][] = [];
    for (let i = 0; i < flat.length; i += 4) {
      rows.push(flat.slice(i, i + 4));
    }
    return rows;
  })();

  // Set of cards played up to current trick / card step in replay mode
  const playedCardKeysUpToStep = new Set<string>();
  if (historyModalBoard && historyViewMode === 'play') {
    for (let t = 0; t < selectedTrickIdx; t++) {
      for (const play of modalTricks[t]?.cards || []) {
        playedCardKeysUpToStep.add(`${play.card.suit}-${play.card.rank}`);
      }
    }
    const curTrickCards = modalTricks[selectedTrickIdx]?.cards || [];
    for (let p = 0; p < Math.min(revealedCardStep, curTrickCards.length); p++) {
      const play = curTrickCards[p];
      playedCardKeysUpToStep.add(`${play.card.suit}-${play.card.rank}`);
    }
  }

  const effectiveMaxStepForTrick = (tIdx: number): number => {
    const trickLen = modalTricks[tIdx]?.cards.length || 0;
    if (modalAcceptedClaim && claimCutoffTrickIdx !== null && tIdx === claimCutoffTrickIdx && claimCutoffCardStep !== null) {
      return Math.min(trickLen, claimCutoffCardStep);
    }
    return trickLen;
  };

  const maxReplayTrickIdx =
    modalAcceptedClaim && claimCutoffTrickIdx !== null
      ? Math.min(Math.max(0, modalTricks.length - 1), claimCutoffTrickIdx)
      : Math.max(0, modalTricks.length - 1);

  const isAtLastCardBeforeClaim = Boolean(
    modalAcceptedClaim &&
      historyViewMode === 'play' &&
      modalTricks.length > 0 &&
      selectedTrickIdx === maxReplayTrickIdx &&
      revealedCardStep >= effectiveMaxStepForTrick(maxReplayTrickIdx)
  );

  const isAtAcceptedClaimCutoff = Boolean(isAtLastCardBeforeClaim && showClaimSummary);

  const replayTricksTally: { NS: number; EW: number } = (() => {
    if (!historyModalBoard) {
      return { NS: 0, EW: 0 };
    }
    if (isAtAcceptedClaimCutoff && modalAcceptedClaim) {
      return {
        NS: historyModalBoard.tricks_ns,
        EW: historyModalBoard.tricks_ew,
      };
    }
    if (historyViewMode !== 'play' || modalTricks.length === 0) {
      return { NS: 0, EW: 0 };
    }
    let ns = 0;
    let ew = 0;
    const completedBeforeCurrent = Math.min(selectedTrickIdx, modalTricks.length);
    for (let t = 0; t < completedBeforeCurrent; t++) {
      const tr = modalTricks[t];
      if (!tr) continue;
      if (sideOf(tr.winner) === 'NS') ns += 1;
      else ew += 1;
    }
    const curTrick = modalTricks[selectedTrickIdx];
    const curMaxStep = effectiveMaxStepForTrick(selectedTrickIdx);
    if (curTrick && curTrick.cards.length > 0 && revealedCardStep >= curTrick.cards.length && revealedCardStep >= curMaxStep) {
      if (sideOf(curTrick.winner) === 'NS') ns += 1;
      else ew += 1;
    }
    return { NS: ns, EW: ew };
  })();

  const currentHistoryIdx = historyModalBoard
    ? history.findIndex((b) => b.id === historyModalBoard.id)
    : -1;
  const prevHistoryBoard: CompletedBoardRecord | null =
    currentHistoryIdx >= 0 && history.length > 1
      ? history[(currentHistoryIdx - 1 + history.length) % history.length]
      : null;
  const nextHistoryBoard: CompletedBoardRecord | null =
    currentHistoryIdx >= 0 && history.length > 1
      ? history[(currentHistoryIdx + 1) % history.length]
      : null;

  const cardPlayedBeforeClaim: { seat: Seat; card: Card } | null = (() => {
    if (!modalAcceptedClaim || modalTricks.length === 0) return null;
    if (modalAcceptedClaim.acceptedAtCard) {
      return modalAcceptedClaim.acceptedAtCard;
    }
    const tIdx = Math.min(maxReplayTrickIdx, Math.max(0, modalTricks.length - 1));
    const trickCards = modalTricks[tIdx]?.cards || [];
    const maxStep = effectiveMaxStepForTrick(tIdx);
    const stepIdx = maxStep > 0 ? Math.min(trickCards.length - 1, maxStep - 1) : -1;
    if (stepIdx >= 0 && trickCards[stepIdx]) {
      return trickCards[stepIdx];
    }
    for (let i = tIdx - 1; i >= 0; i--) {
      const prevCards = modalTricks[i]?.cards || [];
      if (prevCards.length > 0) {
        return prevCards[prevCards.length - 1];
      }
    }
    return null;
  })();

  const vulClass = `vul-${(game?.vulnerability || 'NONE').toLowerCase()}`;

  return (
    <div className="felt-shell">
      <aside className="felt-left-rail">
        <button
          type="button"
          className="rail-menu-btn"
          onClick={() => setDrawerOpen((o) => !o)}
          title="Boards, Scoreboard & Room Settings"
        >
          ☰
        </button>

        <div
          className={`rail-board-box has-dealer-edge dealer-${(game?.dealer || 'N').toLowerCase()} hover-anchor ${vulClass}`}
          style={{
            padding: 12,
            borderWidth: 14,
            position: 'relative',
          }}
          onMouseEnter={() => setHoverBoardPopup(true)}
          onMouseLeave={() => setHoverBoardPopup(false)}
          onClick={() => {
            setHoverBoardPopup((prev) => !prev);
            setHoverContractPopup(false);
            setHoverLastTrickPopup(false);
          }}
        >
          <span
            className="rail-dealer-edge-mark"
            style={{
              position: 'absolute',
              fontSize: 11,
              fontWeight: 800,
              lineHeight: 1,
              pointerEvents: 'none',
              color:
                (game?.vulnerability === 'BOTH' ||
                  (game?.vulnerability === 'NS' &&
                    ((game?.dealer ?? 'N') === 'N' || (game?.dealer ?? 'N') === 'S')) ||
                  (game?.vulnerability === 'EW' &&
                    ((game?.dealer ?? 'N') === 'E' || (game?.dealer ?? 'N') === 'W')))
                  ? '#ffffff'
                  : '#111827',
              ...((game?.dealer ?? 'N') === 'N'
                ? { top: -13, left: '50%', transform: 'translateX(-50%)' }
                : (game?.dealer ?? 'N') === 'S'
                ? { bottom: -13, left: '50%', transform: 'translateX(-50%)' }
                : (game?.dealer ?? 'N') === 'W'
                ? { left: -13, top: '50%', transform: 'translateY(-50%)' }
                : { right: -13, top: '50%', transform: 'translateY(-50%)' }),
            }}
          >
            D
          </span>
          <div className="rail-board-inner">
            <div className="rail-board-num">{game?.boardNumber ?? 1}</div>
          </div>

          {hoverBoardPopup && (
            <div
              className="rail-hover-popover board-scores-popover"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="popover-title">Table &amp; Duplicate Records</div>
              <div className="scorecard-sheet-wrap">
                <table className="scorecard-sheet-table">
                  <thead>
                    <tr>
                      <th>Board</th>
                      <th>Result</th>
                      <th>We</th>
                      <th>They</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="scorecard-empty-cell">
                          No completed boards yet.
                        </td>
                      </tr>
                    ) : (
                      history.map((b, idx) => {
                        const info = formatContractAndResult(b);
                        const isEven = idx % 2 === 1;
                        return (
                          <tr
                            key={b.id}
                            className={`scorecard-row ${isEven ? 'alt-row' : ''}`}
                          >
                            <td>{b.board_number}</td>
                            <td className="scorecard-result-cell">
                              <span>{info.compactResult}</span>
                            </td>
                            <td className="scorecard-pts-cell" style={{ textAlign: 'center' }}>
                              {b.score_ns > 0 ? b.score_ns : ''}
                            </td>
                            <td className="scorecard-pts-cell" style={{ textAlign: 'center' }}>
                              {b.score_ew > 0 ? b.score_ew : ''}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="scorecard-total-row">
                      <td colSpan={2}>Total</td>
                      <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>{cumulativeScore.NS}</td>
                      <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>{cumulativeScore.EW}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>

        <div
          className="rail-contract-box hover-anchor"
          onMouseEnter={() => setHoverContractPopup(true)}
          onMouseLeave={() => setHoverContractPopup(false)}
          onClick={() => {
            setHoverContractPopup((prev) => !prev);
            setHoverBoardPopup(false);
            setHoverLastTrickPopup(false);
          }}
        >
          <div className="rail-contract-main">
            {game?.contract ? (
              <span className="bid-text-black">
                {game.contract.level}
                <span className={isRedStrain(game.contract.strain) ? 'suit-red' : 'suit-black'}>
                  {SUIT_SYM[game.contract.strain]}
                </span>
                {game.contract.doubled === 1 ? 'X' : game.contract.doubled === 2 ? 'XX' : ''}
              </span>
            ) : (
              '—'
            )}
          </div>
          <div className="rail-contract-by">
            {game?.contract?.declarer
              ? game.phase === 'PLAYING'
                ? `${game.contract.level}${
                    game.contract.strain === 'NT' ? 'NT' : SUIT_SYM[game.contract.strain]
                  }${
                    game.contract.doubled === 1
                      ? 'X'
                      : game.contract.doubled === 2
                      ? 'XX'
                      : ''
                  } - ${game.contract.declarer}`
                : game.contract.declarer
              : 'Auction'}
          </div>

          {hoverContractPopup && game && (
            <div className="rail-hover-popover contract-popover">
              <div className="popover-title">Bidding Sequence</div>
              {game.auction.length === 0 ? (
                <div className="popover-empty">No bids yet</div>
              ) : (
                <div className="popover-auction-grid">
                  {auctionCols.map((col) => (
                    <div key={col} className="popover-col-head">
                      {col}
                    </div>
                  ))}
                  {auctionRows.map((row, rIdx) =>
                    row.map((cell, cIdx) => (
                      <div key={`${rIdx}-${cIdx}`} className="popover-cell">
                        {renderAuctionCellContent(cell, 'popover')}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div
          className="rail-tricks-box hover-anchor"
          onMouseEnter={() => setHoverLastTrickPopup(true)}
          onMouseLeave={() => setHoverLastTrickPopup(false)}
          onClick={() => {
            setHoverLastTrickPopup((prev) => !prev);
            setHoverBoardPopup(false);
            setHoverContractPopup(false);
          }}
        >
          <span>{game?.tricksWon.NS ?? 0}</span>
          <span>{game?.tricksWon.EW ?? 0}</span>

          {hoverLastTrickPopup && game && (
            <div className="rail-hover-popover trick-popover">
              <div className="popover-title">
                {lastTrick ? `Last Trick · Won by ${lastTrick.winner}` : 'Last Trick'}
              </div>
              {!lastTrick ? (
                <div className="popover-empty">No completed trick yet</div>
              ) : (
                <div className="trick-mini-table">
                  {lastTrick.cards.slice(0, animatedTrickCount).map((play, idx) => {
                    const slot = visualSlotForSeat(play.seat);
                    return (
                      <div
                        key={`${play.seat}-${idx}`}
                        className={`trick-mini-slot trick-mini-${slot} trick-anim-pop`}
                      >
                        <span className="trick-mini-seat">{play.seat}</span>
                        <HoverTrickCardPicture card={play.card} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {game && (
          <button
            type="button"
            className={`rail-chat-btn ${chatOpen ? 'active' : ''}`}
            onClick={() => setChatOpen((prev) => !prev)}
            title="Table Chat (visible to all 4 players)"
          >
            <span>Chat</span>
            {unreadChatCount > 0 && (
              <span className="rail-chat-badge">
                {unreadChatCount > 99 ? '99+' : unreadChatCount}
              </span>
            )}
          </button>
        )}

        {canDeclarerClaim ? (
          <button
            type="button"
            className="rail-claim-btn"
            onClick={() => {
              setClaimTricksInput(maxClaimableTricks);
              setClaimModalOpen(true);
            }}
          >
            Claim
          </button>
        ) : (
          <button
            type="button"
            className="rail-claim-btn"
            onClick={() => {
              setScoreModalOpen(true);
            }}
          >
            Scores
          </button>
        )}
      </aside>

      <main className="felt-stage">
        {errorMsg && <div className="felt-toast-error">{errorMsg}</div>}

        {!game ? (
          <div className="felt-join-overlay">
            <div className="felt-join-card">
              <h2>Contract Bridge Lobby</h2>
              <p className="felt-conn-status">
                {connected ? '● Server Online (:3001)' : '○ Connecting to Server (:3001)...'}
              </p>
              <div className="felt-lobby-form">
                <input
                  value={playerNameInput}
                  onChange={(e) => setPlayerNameInput(e.target.value)}
                  placeholder="Your display name"
                  className="felt-name-input"
                />
                <div className="felt-join-row">
                  <input
                    value={tableId}
                    onChange={(e) => setTableId(e.target.value)}
                    placeholder="Room ID"
                  />
                  <select
                    value={selectedSeat}
                    onChange={(e) => setSelectedSeat(e.target.value as Seat)}
                  >
                    {SEATS.map((s) => (
                      <option key={s} value={s}>
                        Seat {s}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rail-claim-btn"
                    onClick={() => joinSeat(selectedSeat)}
                  >
                    Sit Down
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="seat-zone-top">
              {topIsFaceUp || isClaimRevealed ? (
                <HorizontalSuitHand
                  cards={topCards}
                  canPlayCard={(c) =>
                    Boolean(game.phase === 'PLAYING' && isMyTurn && activeHandSeat === topSeat) &&
                    c.rank > 0
                  }
                  onPlayCard={sendCard}
                  mode={dummyModeForSeat(topSeat)}
                  suitOrder={contractSuitOrder}
                />
              ) : (
                <FanCardBack orientation="top" count={topCards.length || 13} />
              )}
              <div
                className={`felt-nameplate ${
                  game.currentTurn === topSeat
                    ? isMyTurn && activeHandSeat === topSeat
                      ? 'my-turn-yellow'
                      : 'active-turn'
                    : ''
                }`}
              >
                <span className="felt-seat-tag">{topSeat}</span>
                <span className="felt-player-name">{formatSeatLabel(topSeat)}</span>
              </div>
            </div>

            <div className="seat-zone-middle">
              <div className="seat-zone-side">
                {leftIsFaceUp || isClaimRevealed ? (
                  <HorizontalSuitHand
                    cards={leftCards}
                    canPlayCard={(c) =>
                      Boolean(game.phase === 'PLAYING' && isMyTurn && activeHandSeat === leftSeat) &&
                      c.rank > 0
                    }
                    onPlayCard={sendCard}
                    mode={dummyModeForSeat(leftSeat)}
                    suitOrder={contractSuitOrder}
                  />
                ) : (
                  <FanCardBack orientation="left" count={leftCards.length || 13} />
                )}
                <div
                  className={`felt-nameplate ${
                    game.currentTurn === leftSeat
                      ? isMyTurn && activeHandSeat === leftSeat
                        ? 'my-turn-yellow'
                        : 'active-turn'
                      : ''
                  }`}
                >
                  <span className="felt-seat-tag">{leftSeat}</span>
                  <span className="felt-player-name">{formatSeatLabel(leftSeat)}</span>
                </div>
              </div>

              <div className="center-table-area">
                {game && game.phase !== 'FINISHED' && (
                  <div className={`felt-turn-notification ${isMyTurn ? 'my-turn-notify' : ''}`}>
                    <span className="turn-notify-dot">●</span>
                    <span>
                      Turn: <strong>{turnDisplayLabel}</strong>
                      {isMyTurn ? ' (Your Turn)' : ''}
                    </span>
                  </div>
                )}

                {game.claim && !game.claim.rejectedRevealed && (
                  <div className="felt-claim-banner">
                    <div>
                      <strong>{displayNameForSeat(game.claim.claimedBy)}</strong> claims{' '}
                      <strong>{game.claim.claimedDeclarerTricks}</strong> total tricks for{' '}
                      {declarerSide}.
                    </div>
                    {isDefender ? (
                      <div className="claim-actions">
                        <button
                          type="button"
                          className="claim-accept-btn"
                          onClick={() => respondClaim(true)}
                        >
                          Accept Claim
                        </button>
                        <button
                          type="button"
                          className="claim-reject-btn"
                          onClick={() => respondClaim(false)}
                        >
                          Reject Claim
                        </button>
                      </div>
                    ) : (
                      <div className="claim-waiting-text">Waiting for defenders to respond...</div>
                    )}
                  </div>
                )}

                {game.claim && game.claim.rejectedRevealed && (
                  <div className="felt-claim-rejected-banner">
                    <span>
                      Claim of {game.claim.claimedDeclarerTricks} tricks rejected — play continues or you may claim again.
                    </span>
                    {isDeclarer && (
                      <button
                        type="button"
                        className="claim-reclaim-btn"
                        onClick={() => {
                          setClaimTricksInput(maxClaimableTricks);
                          setClaimModalOpen(true);
                        }}
                      >
                        Claim Again
                      </button>
                    )}
                  </div>
                )}

                {game.phase === 'BIDDING' ? (
                  <div className="felt-auction-board">
                    <div className="felt-auction-header">
                      {auctionCols.map((col) => {
                        const isSeatVul =
                          game.vulnerability === 'BOTH' ||
                          (game.vulnerability === 'NS' && (col === 'N' || col === 'S')) ||
                          (game.vulnerability === 'EW' && (col === 'E' || col === 'W'));
                        return (
                          <div
                            key={col}
                            className={`felt-auction-col-title ${isSeatVul ? 'is-vul-seat' : ''}`}
                            style={
                              isSeatVul
                                ? {
                                    background: '#dc2626',
                                    backgroundColor: '#dc2626',
                                    color: '#ffffff',
                                    borderRadius: 4,
                                  }
                                : undefined
                            }
                          >
                            {col}
                          </div>
                        );
                      })}
                    </div>
                    <div className="felt-auction-body">
                      {auctionRows.map((row, rIdx) => (
                        <div key={rIdx} className="felt-auction-row">
                          {row.map((cell, cIdx) => (
                            <div key={cIdx} className="felt-auction-cell">
                              {renderAuctionCellContent(cell, 'board')}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="felt-trick-stage">
                    {displayedTrick.map((t, idx) => (
                      <div
                        key={`${t.seat}-${idx}`}
                        className={`trick-slot trick-slot-${visualSlotForSeat(t.seat)}`}
                      >
                        <CenterTrickCard card={t.card} />
                      </div>
                    ))}
                  </div>
                )}

                {game.phase === 'BIDDING' && mySeat && game.currentTurn === mySeat && (
                  <div className="felt-bidding-panel">
                    <div className="felt-bid-bar">
                      <button
                        type="button"
                        className="felt-bid-pass-btn"
                        onClick={() => sendBid({ type: 'PASS' })}
                      >
                        Pass
                      </button>
                      {[1, 2, 3, 4, 5, 6, 7].map((lvl) => {
                        const legal = auctionStatus.isLevelLegal(lvl);
                        if (!legal) return null;
                        return (
                          <button
                            key={lvl}
                            type="button"
                            className={`felt-bid-lvl-btn ${selectedBidLevel === lvl ? 'selected' : ''}`}
                            onClick={() => setSelectedBidLevel(lvl)}
                          >
                            {lvl}
                          </button>
                        );
                      })}
                      {auctionStatus.canDouble && (
                        <button
                          type="button"
                          className="felt-bid-mod-btn"
                          onClick={() => sendBid({ type: 'DOUBLE' })}
                          title="Double"
                        >
                          X
                        </button>
                      )}
                      {auctionStatus.canRedouble && (
                        <button
                          type="button"
                          className="felt-bid-mod-btn"
                          onClick={() => sendBid({ type: 'REDOUBLE' })}
                          title="Redouble"
                        >
                          XX
                        </button>
                      )}
                    </div>

                    {selectedBidLevel !== null && auctionStatus.isLevelLegal(selectedBidLevel) && (
                      <div className="felt-strain-row">
                        {STRAIN_ORDER.filter((st) => auctionStatus.isStrainLegal(selectedBidLevel, st)).map(
                          (st) => (
                            <button
                              key={st}
                              type="button"
                              className="felt-strain-btn"
                              onClick={() =>
                                sendBid({
                                  type: 'CONTRACT',
                                  level: selectedBidLevel,
                                  strain: st,
                                })
                              }
                            >
                              <span className="bid-text-black">{selectedBidLevel}</span>
                              <span className={isRedStrain(st) ? 'suit-red' : 'suit-black'}>
                                {SUIT_SYM[st]}
                              </span>
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>
                )}

                {game.phase === 'FINISHED' && game.score && (
                  <div className="felt-finished-bar">
                    <span>
                      Board #{game.boardNumber}: NS {game.score.NS} / EW {game.score.EW}
                    </span>
                    <button type="button" className="rail-claim-btn" onClick={nextBoard}>
                      Next Board →
                    </button>
                  </div>
                )}
              </div>

              <div className="seat-zone-side">
                {rightIsFaceUp || isClaimRevealed ? (
                  <HorizontalSuitHand
                    cards={rightCards}
                    canPlayCard={(c) =>
                      Boolean(game.phase === 'PLAYING' && isMyTurn && activeHandSeat === rightSeat) &&
                      c.rank > 0
                    }
                    onPlayCard={sendCard}
                    mode={dummyModeForSeat(rightSeat)}
                    suitOrder={contractSuitOrder}
                  />
                ) : (
                  <FanCardBack orientation="right" count={rightCards.length || 13} />
                )}
                <div
                  className={`felt-nameplate ${
                    game.currentTurn === rightSeat
                      ? isMyTurn && activeHandSeat === rightSeat
                        ? 'my-turn-yellow'
                        : 'active-turn'
                      : ''
                  }`}
                >
                  <span className="felt-seat-tag">{rightSeat}</span>
                  <span className="felt-player-name">{formatSeatLabel(rightSeat)}</span>
                </div>
              </div>
            </div>

            <div className={`seat-zone-bottom ${isMyTurn ? 'my-turn-hand-border' : ''}`}>
              {game.phase === 'FINISHED' && dummyModeForSeat(bottomSeat) === 'defender-dummy' ? (
                <div className="finished-bottom-suit-wrap">
                  <HorizontalSuitHand
                    cards={bottomCards}
                    canPlayCard={() => false}
                    onPlayCard={() => {}}
                    mode="defender-dummy"
                    suitOrder={contractSuitOrder}
                  />
                </div>
              ) : (
              <div className="felt-strip-row bottom-hand-strip" style={{ width: `${Math.max(bottomCards.length, 0) * 56}px` }}>
                {bottomCards.map((c, idx) => (
                  <StripCardFace
                    key={`${c.suit}-${c.rank}-${idx}`}
                    card={c}
                    disabled={
                      c.rank === 0 ||
                      !(game.phase === 'PLAYING' && isMyTurn && activeHandSeat === bottomSeat)
                    }
                    onClick={() => sendCard(c)}
                    highlighted={game.currentTurn === bottomSeat}
                  />
                ))}
              </div>
              )}
              <div
                className={`felt-bottom-bar ${
                  isMyTurn ? 'my-move-active' : 'my-move-idle'
                }`}
              >
                <div className="felt-bottom-left">
                  <span className="felt-seat-tag">{bottomSeat}</span>
                  <span className={`felt-player-icon ${isMyTurn ? 'turn-yellow' : ''}`}>
                    ♛
                  </span>
                  <span className="felt-bottom-user">
                    {mySeat
                      ? `${displayNameForSeat(bottomSeat)} · ${tableId}`
                      : 'Spectator'}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {pendingPartnerExplainRequests.length > 0 && game && (
          <div className="partner-explain-banner">
            <span>
              Opponents asked you to explain partner&apos;s{' '}
              <strong>
                {renderColoredBidCall(pendingPartnerExplainRequests[0].entry.call)}
              </strong>
              :
            </span>
            <button
              type="button"
              className="claim-accept-btn"
              onClick={() =>
                openPartnerExplainModal(
                  pendingPartnerExplainRequests[0].bidIndex,
                  pendingPartnerExplainRequests[0].entry.explanation
                )
              }
            >
              Explain Bid
            </button>
          </div>
        )}

        {explainingBidIndex !== null && game && game.auction[explainingBidIndex] && (
          <div className="felt-drawer-backdrop" onClick={() => setExplainingBidIndex(null)}>
            <div className="felt-claim-modal" onClick={(e) => e.stopPropagation()}>
              <h3>
                Explain Partner&apos;s Bid ({game.auction[explainingBidIndex].seat}:{' '}
                {renderColoredBidCall(game.auction[explainingBidIndex].call)})
              </h3>
              <p>
                Provide the partnership agreement / meaning of this call for the opponents.
              </p>
              <input
                type="text"
                value={explanationInput}
                onChange={(e) => setExplanationInput(e.target.value)}
                placeholder="e.g. 15-17 balanced, Stayman, Jacoby transfer..."
                className="felt-drawer-name-input"
                autoFocus
              />
              <div className="claim-modal-btns" style={{ marginTop: 12 }}>
                {!game.auction[explainingBidIndex].alerted && (
                  <button
                    type="button"
                    className="claim-accept-btn"
                    onClick={() => submitPartnerExplanation(true)}
                  >
                    Alert &amp; Save Explanation
                  </button>
                )}
                <button
                  type="button"
                  className="claim-accept-btn"
                  disabled={!explanationInput.trim()}
                  onClick={() => submitPartnerExplanation(false)}
                >
                  Save Explanation
                </button>
                <button
                  type="button"
                  className="claim-cancel-btn"
                  onClick={() => setExplainingBidIndex(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {claimModalOpen && game && (
          <div className="felt-drawer-backdrop" onClick={() => setClaimModalOpen(false)}>
            <div className="felt-claim-modal" onClick={(e) => e.stopPropagation()}>
              <h3>Claim Tricks</h3>
              <p>
                Current {declarerSide} tricks: <strong>{currentDeclarerTricks}</strong> · Remaining:{' '}
                <strong>{remainingTricks}</strong>
              </p>
              <label className="claim-label">
                Total tricks claimed for {declarerSide} ({currentDeclarerTricks}–{maxClaimableTricks}):
              </label>
              <input
                type="number"
                min={currentDeclarerTricks}
                max={maxClaimableTricks}
                value={claimTricksInput}
                onChange={(e) => setClaimTricksInput(Number(e.target.value))}
                className="claim-number-input"
              />
              <div className="claim-modal-btns">
                <button type="button" className="claim-accept-btn" onClick={submitClaim}>
                  Submit Claim
                </button>
                <button type="button" className="claim-cancel-btn" onClick={() => setClaimModalOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {historyModalBoard && (
          <div
            className="felt-drawer-backdrop board-history-backdrop"
            onClick={() => setHistoryModalBoard(null)}
          >
            <div
              className="board-history-modal replay-table-modal"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-label={`Board ${historyModalBoard.board_number} History`}
            >
              <div className="replay-top-bar">


                <div className="replay-title-meta">
                  <strong>Board #{historyModalBoard.board_number}</strong> ·{' '}
                  {formatContractAndResult(historyModalBoard).contractLabel} (
                  {formatContractAndResult(historyModalBoard).resultLabel}) · Vul: {modalVul}
                </div>

                <button
                  type="button"
                  className="board-history-close"
                  onClick={() => setHistoryModalBoard(null)}
                >
                  ✕
                </button>
              </div>

              <div className="replay-green-stage">
                <div className="replay-top-row">
                  <div
                    className={`rail-board-box has-dealer-edge dealer-${modalDealer.toLowerCase()} replay-board-badge-box vul-${modalVul.toLowerCase()}`}
                    style={{
                      padding: 12,
                      borderWidth: 14,
                      position: 'relative',
                    }}
                  >
                    <span
                      className="rail-dealer-edge-mark"
                      style={{
                        position: 'absolute',
                        fontSize: 11,
                        fontWeight: 800,
                        lineHeight: 1,
                        pointerEvents: 'none',
                        color:
                          modalVul === 'BOTH' ||
                          (modalVul === 'NS' && (modalDealer === 'N' || modalDealer === 'S')) ||
                          (modalVul === 'EW' && (modalDealer === 'E' || modalDealer === 'W'))
                            ? '#ffffff'
                            : '#111827',
                        ...(modalDealer === 'N'
                          ? { top: -13, left: '50%', transform: 'translateX(-50%)' }
                          : modalDealer === 'S'
                          ? { bottom: -13, left: '50%', transform: 'translateX(-50%)' }
                          : modalDealer === 'W'
                          ? { left: -13, top: '50%', transform: 'translateY(-50%)' }
                          : { right: -13, top: '50%', transform: 'translateY(-50%)' }),
                      }}
                    >
                      D
                    </span>
                    <div className="rail-board-inner">
                      <div className="rail-board-num">{historyModalBoard.board_number}</div>
                    </div>
                  </div>

                  <ReplaySuitHandBox
                    seat="N"
                    label={displayNameForSeat('N')}
                    cards={modalHands.N || []}
                    playedSet={playedCardKeysUpToStep}
                    highlightTop={Boolean(
                      isAtAcceptedClaimCutoff &&
                        modalAcceptedClaim &&
                        sideOf(modalAcceptedClaim.claimedBy) === 'NS'
                    )}
                  />

                  <div className="replay-top-spacer" />
                </div>

                <div className="replay-mid-row">
                  <ReplaySuitHandBox
                    seat="W"
                    label={displayNameForSeat('W')}
                    cards={modalHands.W || []}
                    playedSet={playedCardKeysUpToStep}
                  />

                  <div className="replay-center-panel">
                    {historyViewMode === 'bidding' && !isAtAcceptedClaimCutoff ? (
                      <div className="replay-auction-card">
                        <div className="replay-auction-head">
                          {auctionCols.map((c) => (
                            <div key={c}>{c}</div>
                          ))}
                        </div>
                        <div className="replay-auction-grid">
                          {modalAuctionRows.map((row, rIdx) =>
                            row.map((entry, cIdx) => (
                              <div key={`${rIdx}-${cIdx}`} className="replay-auction-call">
                                {entry ? renderColoredBidCall(entry.call) : ''}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="replay-trick-arena">
                        <>
                          {modalTricks[selectedTrickIdx]?.cards
                            .slice(0, revealedCardStep)
                            .map((play, pIdx) => {
                              const slotPos =
                                play.seat === 'N'
                                  ? 'slot-n'
                                  : play.seat === 'S'
                                  ? 'slot-s'
                                  : play.seat === 'W'
                                  ? 'slot-w'
                                  : 'slot-e';
                              return (
                                <div
                                  key={`${play.seat}-${pIdx}`}
                                  className={`replay-played-slot ${slotPos}`}
                                  title={`#${pIdx + 1} ${play.seat}`}
                                >
                                  <HoverTrickCardPicture card={play.card} />
                                </div>
                              );
                            })}
                        </>
                        {isAtAcceptedClaimCutoff && modalAcceptedClaim && (
                          <div
                            className="felt-claim-banner"
                            style={{
                              position: 'fixed',
                              top: '50%',
                              left: '50%',
                              transform: 'translate(-50%, -50%)',
                              zIndex: 1200,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              textAlign: 'center',
                              minHeight: 72,
                              padding: '14px 20px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                textAlign: 'center',
                                width: '100%',
                                height: '100%',
                              }}
                            >
                              <span style={{ whiteSpace: 'pre-wrap' }}>
                                <strong>{displayNameForSeat(modalAcceptedClaim.claimedBy)}</strong>
                                {' claims '}
                                <strong>{modalAcceptedClaim.claimedDeclarerTricks}</strong>
                                {' total tricks accepted ('}
                                {historyModalBoard.score_ns >= 0
                                  ? `+${historyModalBoard.score_ns}`
                                  : historyModalBoard.score_ns}
                                {').'}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <ReplaySuitHandBox
                    seat="E"
                    label={displayNameForSeat('E')}
                    cards={modalHands.E || []}
                    playedSet={playedCardKeysUpToStep}
                  />
                </div>

                <div className="replay-bottom-row">
                  <ReplaySuitHandBox
                    seat="S"
                    label={displayNameForSeat('S')}
                    cards={modalHands.S || []}
                    playedSet={playedCardKeysUpToStep}
                  />

                  <div className="replay-contract-tally-box">
                    <div className="replay-contract-summary">
                      <div>{historyModalBoard.contract_text || 'Pass'}</div>
                      <div>{historyModalBoard.declarer || '—'}</div>
                    </div>
                    <div className="replay-tricks-tally">
                      <span>{replayTricksTally.NS}</span>
                      <span>{replayTricksTally.EW}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="replay-nav-footer">
                <button
                  type="button"
                  className="replay-nav-btn active"
                  disabled={!prevHistoryBoard}
                  onClick={() => {
                    if (!prevHistoryBoard) return;
                    setHistoryModalBoard(prevHistoryBoard);
                    setHistoryViewMode('bidding');
                    setSelectedTrickIdx(0);
                    setRevealedCardStep(0);
                    setShowClaimSummary(false);
                  }}
                >
                  Previous deal
                </button>
                <button
                  type="button"
                  className="replay-nav-btn active"
                  disabled={!nextHistoryBoard}
                  onClick={() => {
                    if (!nextHistoryBoard) return;
                    setHistoryModalBoard(nextHistoryBoard);
                    setHistoryViewMode('bidding');
                    setSelectedTrickIdx(0);
                    setRevealedCardStep(0);
                    setShowClaimSummary(false);
                  }}
                >
                  Next deal
                </button>
                <button
                  type="button"
                  className="replay-nav-btn active"
                  disabled={
                    historyViewMode !== 'play' ||
                    (!showClaimSummary && selectedTrickIdx === 0 && revealedCardStep <= 1)
                  }
                  onClick={() => {
                    if (historyViewMode !== 'play') {
                      setHistoryViewMode('play');
                      return;
                    }
                    if (showClaimSummary) {
                      setShowClaimSummary(false);
                      return;
                    }
                    if (revealedCardStep > 1) {
                      setRevealedCardStep((s) => s - 1);
                    } else if (selectedTrickIdx > 0) {
                      const prevIdx = selectedTrickIdx - 1;
                      setSelectedTrickIdx(prevIdx);
                      setRevealedCardStep(modalTricks[prevIdx]?.cards.length || 4);
                    }
                  }}
                >
                  Previous card
                </button>
                <button
                  type="button"
                  className="replay-nav-btn active"
                  disabled={
                    modalTricks.length === 0 ||
                    (historyViewMode === 'play' &&
                      selectedTrickIdx === maxReplayTrickIdx &&
                      revealedCardStep >= effectiveMaxStepForTrick(maxReplayTrickIdx) &&
                      (!modalAcceptedClaim || showClaimSummary))
                  }
                  onClick={() => {
                    if (historyViewMode !== 'play') {
                      setHistoryViewMode('play');
                      setShowClaimSummary(false);
                      setSelectedTrickIdx(0);
                      setRevealedCardStep(effectiveMaxStepForTrick(0) > 0 ? 1 : 0);
                      return;
                    }
                    const curMax = effectiveMaxStepForTrick(selectedTrickIdx);
                    if (revealedCardStep < curMax) {
                      setRevealedCardStep((s) => Math.min(curMax, s + 1));
                    } else if (selectedTrickIdx < maxReplayTrickIdx) {
                      const nextIdx = selectedTrickIdx + 1;
                      setSelectedTrickIdx(nextIdx);
                      setRevealedCardStep(effectiveMaxStepForTrick(nextIdx) > 0 ? 1 : 0);
                    } else if (modalAcceptedClaim && !showClaimSummary) {
                      setShowClaimSummary(true);
                    }
                  }}
                >
                  Next card
                </button>
                <button
                  type="button"
                  className="replay-nav-btn active"
                  disabled={
                    modalTricks.length === 0 ||
                    (historyViewMode === 'play' &&
                      !showClaimSummary &&
                      selectedTrickIdx === 0 &&
                      revealedCardStep <= 0)
                  }
                  onClick={() => {
                    if (historyViewMode !== 'play') {
                      setHistoryViewMode('play');
                      setShowClaimSummary(false);
                      setSelectedTrickIdx(0);
                      setRevealedCardStep(0);
                      return;
                    }
                    if (showClaimSummary) {
                      setShowClaimSummary(false);
                      setSelectedTrickIdx(maxReplayTrickIdx);
                      setRevealedCardStep(effectiveMaxStepForTrick(maxReplayTrickIdx));
                      return;
                    }
                    if (revealedCardStep > 0) {
                      setRevealedCardStep(0);
                      return;
                    }
                    if (selectedTrickIdx > 0) {
                      const prevIdx = selectedTrickIdx - 1;
                      setSelectedTrickIdx(prevIdx);
                      setRevealedCardStep(0);
                    }
                  }}
                >
                  Previous trick
                </button>
                <button
                  type="button"
                  className="replay-nav-btn active"
                  disabled={
                    modalTricks.length === 0 ||
                    (historyViewMode === 'play' &&
                      selectedTrickIdx >= maxReplayTrickIdx &&
                      revealedCardStep >= effectiveMaxStepForTrick(maxReplayTrickIdx) &&
                      (!modalAcceptedClaim || showClaimSummary))
                  }
                  onClick={() => {
                    if (historyViewMode !== 'play') {
                      setHistoryViewMode('play');
                      setShowClaimSummary(false);
                      setSelectedTrickIdx(0);
                      setRevealedCardStep(effectiveMaxStepForTrick(0));
                      return;
                    }
                    if (
                      selectedTrickIdx >= maxReplayTrickIdx &&
                      revealedCardStep >= effectiveMaxStepForTrick(maxReplayTrickIdx)
                    ) {
                      if (modalAcceptedClaim && !showClaimSummary) {
                        setShowClaimSummary(true);
                      }
                      return;
                    }
                    const nextIdx = Math.min(maxReplayTrickIdx, selectedTrickIdx + 1);
                    setSelectedTrickIdx(nextIdx);
                    setRevealedCardStep(effectiveMaxStepForTrick(nextIdx));
                  }}
                >
                  Next trick
                </button>
              </div>
            </div>
          </div>
        )}

        {drawerOpen && (
          <div className="felt-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
            <div className="felt-drawer-panel" onClick={(e) => e.stopPropagation()}>
              <div className="felt-drawer-head">
                <strong>Table &amp; Seat Menu</strong>
                <button type="button" onClick={() => setDrawerOpen(false)}>
                  ✕
                </button>
              </div>

              <div className="felt-lobby-drawer-fields">
                <input
                  value={playerNameInput}
                  onChange={(e) => setPlayerNameInput(e.target.value)}
                  placeholder="Your display name"
                  className="felt-drawer-name-input"
                />
                <div className="felt-room-bar">
                  <input
                    value={tableId}
                    onChange={(e) => setTableId(e.target.value)}
                    placeholder="Room ID"
                  />
                  <select
                    value={selectedSeat}
                    onChange={(e) => setSelectedSeat(e.target.value as Seat)}
                  >
                    {SEATS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="rail-claim-btn"
                    onClick={() => joinSeat(selectedSeat)}
                  >
                    Sit
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {scoreModalOpen && (
          <div className="felt-drawer-backdrop" onClick={() => setScoreModalOpen(false)}>
            <div className="felt-drawer-panel" onClick={(e) => e.stopPropagation()}>
              <div className="felt-drawer-head">
                <strong>Table &amp; Duplicate Records</strong>
                <button type="button" onClick={() => setScoreModalOpen(false)}>
                  ✕
                </button>
              </div>

              <div className="scorecard-sheet-wrap">
                <table className="scorecard-sheet-table">
                  <thead>
                    <tr>
                      <th>Board</th>
                      <th>Result</th>
                      <th>We</th>
                      <th>They</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="scorecard-empty-cell">
                          No completed boards yet.
                        </td>
                      </tr>
                    ) : (
                      history.map((b, idx) => {
                        const info = formatContractAndResult(b);
                        const isEven = idx % 2 === 1;
                        return (
                          <tr
                            key={b.id}
                            className={`scorecard-row ${isEven ? 'alt-row' : ''}`}
                            onClick={() => {
                              setScoreModalOpen(false);
                              setHistoryModalBoard(b);
                              setHistoryViewMode('bidding');
                              setSelectedTrickIdx(0);
                              setRevealedCardStep(0);
                            }}
                            title="Click to open Board History"
                          >
                            <td>{b.board_number}</td>
                            <td className="scorecard-result-cell">
                              <span>{info.compactResult}</span>

                            </td>
                            <td className="scorecard-pts-cell" style={{ textAlign: 'center' }}>
                              {b.score_ns > 0 ? b.score_ns : ''}
                            </td>
                            <td className="scorecard-pts-cell" style={{ textAlign: 'center' }}>
                              {b.score_ew > 0 ? b.score_ew : ''}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="scorecard-total-row">
                      <td colSpan={2}>Total</td>
                      <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>{cumulativeScore.NS}</td>
                      <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>{cumulativeScore.EW}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          </div>
        )}
        {game && chatOpen && (
          <section className="room-chat-panel" aria-label="In-room table chat">
            <div className="room-chat-header">
              <div className="room-chat-title">
                <span>Table Chat · {tableId}</span>
              </div>
              <button
                type="button"
                className="room-chat-close"
                onClick={() => setChatOpen(false)}
                title="Minimize chat"
              >
                ✕
              </button>
            </div>

            <div className="room-chat-messages">
              {chatMessages.length === 0 ? (
                <div className="room-chat-empty">
                  No messages yet. Say hello to the table!
                </div>
              ) : (
                chatMessages.map((m) => {
                  const isMine = mySeat && m.seat === mySeat;
                  const timeStr = new Date(m.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  });
                  return (
                    <div
                      key={m.id}
                      className={`room-chat-msg ${isMine ? 'mine' : ''}`}
                    >
                      <div className="room-chat-meta">
                        <span className={`room-chat-seat seat-${m.seat.toLowerCase()}`}>
                          {m.seat}
                        </span>
                        <span className="room-chat-sender">{m.senderName}</span>
                        <span className="room-chat-time">{timeStr}</span>
                      </div>
                      <div className="room-chat-bubble">{m.text}</div>
                    </div>
                  );
                })
              )}
              <div ref={chatBottomRef} />
            </div>

            <form className="room-chat-form" onSubmit={sendChatMessage}>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={
                  mySeat
                    ? `Message table as ${displayNameForSeat(mySeat)} (${mySeat})...`
                    : 'Sit at a seat to chat...'
                }
                disabled={!mySeat}
                maxLength={400}
              />
              <button type="submit" disabled={!mySeat || !chatInput.trim()}>
                Send
              </button>
            </form>
          </section>
        )}
      </main>
      {hoveredBidPopover && (
        <div
          className="bid-explanation-popover"
          style={{
            top: Math.max(10, hoveredBidPopover.top - 8),
            left: Math.min(
              Math.max(125, hoveredBidPopover.left),
              typeof window !== 'undefined' ? window.innerWidth - 125 : hoveredBidPopover.left
            ),
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bid-explanation-header">
            Explanation by {hoveredBidPopover.partnerName} ({hoveredBidPopover.partnerSeat})
          </div>
          <div className="bid-explanation-body">{hoveredBidPopover.explanation}</div>
        </div>
      )}
    </div>
  );
}
