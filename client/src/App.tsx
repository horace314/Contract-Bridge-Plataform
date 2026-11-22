import React, { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

type Seat = 'N' | 'E' | 'S' | 'W';
type Suit = 'C' | 'D' | 'H' | 'S';
type Strain = Suit | 'NT';
type SpectatorHandMode = 'ALL_HANDS' | 'DUMMY_AND_REVEALED';

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

interface RoomSummary {
  id: string;
  hasPassword?: boolean;
  boardNumber: number;
  phase: string;
  occupiedCount: number;
  spectatorCount?: number;
  botSeats?: Seat[];
  seats: Partial<Record<Seat, string>>;
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

type LobbyModeTab = 'TOURNAMENT' | 'CASUAL';

interface WallpaperPreset {
  id: string;
  label: string;
  background: string;
  swatchBackground: string;
}

const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    id: 'green-felt',
    label: 'Green Felt',
    background: 'radial-gradient(circle at 50% 35%, #236347 0%, #174531 62%, #0f2e21 100%)',
    swatchBackground: 'radial-gradient(circle at 50% 35%, #236347 0%, #15402d 100%)',
  },
  {
    id: 'wood',
    label: 'Wood',
    background: 'radial-gradient(circle at 50% 35%, #7c4a27 0%, #593318 65%, #3b200e 100%)',
    swatchBackground: 'radial-gradient(circle at 50% 35%, #7c4a27 0%, #4a2912 100%)',
  },
  {
    id: 'dark',
    label: 'Dark',
    background: 'radial-gradient(circle at 50% 35%, #262b36 0%, #181c24 65%, #101319 100%)',
    swatchBackground: 'radial-gradient(circle at 50% 35%, #262b36 0%, #13171e 100%)',
  },
  {
    id: 'burgundy',
    label: 'Burgundy',
    background: 'radial-gradient(circle at 50% 35%, #662232 0%, #471521 65%, #2d0c14 100%)',
    swatchBackground: 'radial-gradient(circle at 50% 35%, #662232 0%, #3b101a 100%)',
  },
  {
    id: 'navy',
    label: 'Navy',
    background: 'radial-gradient(circle at 50% 35%, #1f3d66 0%, #142947 65%, #0c192e 100%)',
    swatchBackground: 'radial-gradient(circle at 50% 35%, #1f3d66 0%, #11223b 100%)',
  },
];

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const PLAY_WALLPAPER_STORAGE_KEY = 'bridge_play_wallpaper';
const PLAY_WALLPAPER_PRESET_STORAGE_KEY = 'bridge_play_wallpaper_preset';
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

const UI_FONT_FAMILY =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

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
  style,
  rankFontSize,
  pipFontSize,
}: {
  card: Card;
  disabled?: boolean;
  onClick?: () => void;
  highlighted?: boolean;
  style?: React.CSSProperties;
  rankFontSize?: string;
  pipFontSize?: string;
}) {
  const red = isRedSuit(card.suit);
  const sym = SUIT_SYM[card.suit];
  const lbl = rankLabel(card.rank);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={style}
      className={`felt-strip-card ${red ? 'suit-red' : 'suit-black'} ${
        !disabled && onClick ? 'playable' : ''
      } ${highlighted ? 'highlighted' : ''}`}
      title={`${lbl}${sym}`}
    >
      <span
        className="felt-strip-rank"
        style={rankFontSize ? { fontSize: rankFontSize } : undefined}
      >
        {lbl}
      </span>
      <span
        className="felt-strip-pip"
        style={pipFontSize ? { fontSize: pipFontSize } : undefined}
      >
        {sym}
      </span>
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
  const [lobbyTab, setLobbyTab] = useState<LobbyModeTab>('CASUAL');
  const [tableId, setTableId] = useState('');
  const tableIdRef = useRef('');
  const [roomPasswordInput, setRoomPasswordInput] = useState('');
  const [showRoomPassword, setShowRoomPassword] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomPassword, setNewRoomPassword] = useState('');
  const [showNewRoomPassword, setShowNewRoomPassword] = useState(false);
  const [newRoomSeat, setNewRoomSeat] = useState<Seat>('S');
  const [fillOpenSeatsWithBots, setFillOpenSeatsWithBots] = useState(false);
  const [botSeats, setBotSeats] = useState<Seat[]>([]);
  const [spectatorHandMode, setSpectatorHandMode] =
    useState<SpectatorHandMode>('ALL_HANDS');
  const [availableRooms, setAvailableRooms] = useState<RoomSummary[]>([]);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );

  const [playWallpaper, setPlayWallpaper] = useState<string | null>(() => {
    try {
      return localStorage.getItem(PLAY_WALLPAPER_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [wallpaperPresetId, setWallpaperPresetId] = useState<string | null>(() => {
    try {
      const savedImg = localStorage.getItem(PLAY_WALLPAPER_STORAGE_KEY);
      if (savedImg) return null;
      const savedPreset = localStorage.getItem(PLAY_WALLPAPER_PRESET_STORAGE_KEY);
      if (savedPreset && WALLPAPER_PRESETS.some((p) => p.id === savedPreset)) {
        return savedPreset;
      }
      return 'green-felt';
    } catch {
      return 'green-felt';
    }
  });
  const wallpaperObjectUrlRef = useRef<string | null>(null);
  const wallpaperInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (wallpaperObjectUrlRef.current) {
        URL.revokeObjectURL(wallpaperObjectUrlRef.current);
        wallpaperObjectUrlRef.current = null;
      }
    };
  }, []);

  const selectWallpaperPreset = (presetId: string) => {
    const matched = WALLPAPER_PRESETS.find((p) => p.id === presetId);
    if (!matched) return;
    if (wallpaperObjectUrlRef.current) {
      URL.revokeObjectURL(wallpaperObjectUrlRef.current);
      wallpaperObjectUrlRef.current = null;
    }
    setPlayWallpaper(null);
    setWallpaperPresetId(matched.id);
    try {
      localStorage.removeItem(PLAY_WALLPAPER_STORAGE_KEY);
      localStorage.setItem(PLAY_WALLPAPER_PRESET_STORAGE_KEY, matched.id);
    } catch {
      // Ignore storage errors
    }
  };

  const applyWallpaperDataUrl = (dataUrl: string) => {
    if (wallpaperObjectUrlRef.current) {
      URL.revokeObjectURL(wallpaperObjectUrlRef.current);
      wallpaperObjectUrlRef.current = null;
    }
    setWallpaperPresetId(null);
    setPlayWallpaper(dataUrl);
    try {
      localStorage.removeItem(PLAY_WALLPAPER_PRESET_STORAGE_KEY);
      localStorage.setItem(PLAY_WALLPAPER_STORAGE_KEY, dataUrl);
    } catch {
      setErrorMsg('Wallpaper applied for this session (image too large to save in browser storage).');
    }
  };

  const handleWallpaperFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setErrorMsg('Please choose a valid image file (PNG, JPG, WebP, etc.).');
      return;
    }

    if (file.size > 2_500_000) {
      if (wallpaperObjectUrlRef.current) {
        URL.revokeObjectURL(wallpaperObjectUrlRef.current);
      }
      const objUrl = URL.createObjectURL(file);
      wallpaperObjectUrlRef.current = objUrl;
      setWallpaperPresetId(null);
      setPlayWallpaper(objUrl);
      setErrorMsg('Large image applied for this session only (over 2.5 MB is not saved across reloads).');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        applyWallpaperDataUrl(reader.result);
      }
    };
    reader.onerror = () => {
      setErrorMsg('Could not read the selected image file.');
    };
    reader.readAsDataURL(file);
  };

  const clearWallpaper = () => {
    if (wallpaperObjectUrlRef.current) {
      URL.revokeObjectURL(wallpaperObjectUrlRef.current);
      wallpaperObjectUrlRef.current = null;
    }
    setPlayWallpaper(null);
    setWallpaperPresetId('green-felt');
    try {
      localStorage.removeItem(PLAY_WALLPAPER_STORAGE_KEY);
      localStorage.setItem(PLAY_WALLPAPER_PRESET_STORAGE_KEY, 'green-felt');
    } catch {
      // Ignore storage errors
    }
  };

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    tableIdRef.current = tableId;
  }, [tableId]);

  const loadRooms = async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms`);
      const data = await res.json();
      if (Array.isArray(data.rooms)) {
        setAvailableRooms(data.rooms);
      }
    } catch {
      // Ignore if endpoint unreachable
    }
  };

  const [selectedSeat, setSelectedSeat] = useState<Seat>('S');
  const [playerNameInput, setPlayerNameInput] = useState(() => {
    try {
      return localStorage.getItem('bridge_player_name') || '';
    } catch {
      return '';
    }
  });
  const [seatNames, setSeatNames] = useState<Partial<Record<Seat, string>>>({});
  const [mySeat, setMySeat] = useState<Seat | null>(null);
  const [isSpectator, setIsSpectator] = useState(false);
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

  useEffect(() => {
    if (lobbyTab === 'TOURNAMENT') {
      setLobbyTab('CASUAL');
    }
  }, [lobbyTab]);

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
      loadRooms();
    });

    s.on('disconnect', () => {
      setConnected(false);
    });

    s.on('connect_error', () => {
      setConnected(false);
      setErrorMsg(`Cannot reach Bridge server at ${SERVER_URL}. Start server on port 3001.`);
    });

    s.on('table_state', (payload) => {
      const activeRoomId = payload.tableId || tableIdRef.current;
      const nextSeat: Seat | null = payload.mySeat ?? null;
      const nextSpectator = Boolean(
        payload.isSpectator || payload.role === 'SPECTATOR' || nextSeat === null
      );

      if (payload.tableId && payload.tableId !== tableIdRef.current) {
        setTableId(payload.tableId);
      }
      if (payload.reconnectToken && nextSeat && !nextSpectator) {
        localStorage.setItem(`bridge_token_${activeRoomId}_${nextSeat}`, payload.reconnectToken);
      }
      if (payload.seatNames) {
        setSeatNames(payload.seatNames);
      }
      if (Array.isArray(payload.botSeats)) {
        setBotSeats(payload.botSeats.filter((seat: unknown): seat is Seat => SEATS.includes(seat as Seat)));
      }
      if (
        payload.spectatorHandMode === 'ALL_HANDS' ||
        payload.spectatorHandMode === 'DUMMY_AND_REVEALED'
      ) {
        setSpectatorHandMode(payload.spectatorHandMode);
      }
      if (Array.isArray(payload.chatMessages)) {
        setChatMessages(payload.chatMessages);
      }
      if (payload.playerName && nextSeat && !nextSpectator) {
        setPlayerNameInput(payload.playerName);
        localStorage.setItem('bridge_player_name', payload.playerName);
      }
      setMySeat(nextSeat);
      setIsSpectator(nextSpectator);
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

    s.on('rooms_updated', (roomsList: RoomSummary[]) => {
      if (Array.isArray(roomsList)) {
        setAvailableRooms(roomsList);
      }
    });

    s.on('room_updated', (updatedRoom: RoomSummary) => {
      if (!updatedRoom || !updatedRoom.id) return;
      setAvailableRooms((prev) =>
        prev.map((r) => (r.id === updatedRoom.id ? { ...r, ...updatedRoom } : r))
      );
    });

    s.on(
      'removed_from_room',
      (payload: { tableId?: string; seat?: Seat; reason?: string }) => {
        const roomName = payload?.tableId || tableIdRef.current;
        if (roomName && payload?.seat) {
          try {
            localStorage.removeItem(`bridge_token_${roomName}_${payload.seat}`);
          } catch {
            // Ignore storage errors
          }
        }
        setErrorMsg(
          payload?.reason ||
            (roomName
              ? `You were removed from room "${roomName}".`
              : 'You were removed from the table.')
        );
      }
    );

    s.on('left_table', () => {
      setGame(null);
      setMySeat(null);
      setIsSpectator(false);
      setSeatNames({});
      setBotSeats([]);
      setSpectatorHandMode('ALL_HANDS');
      setDisplayedTrick([]);
      setSelectedBidLevel(null);
      setExplainingBidIndex(null);
      setExplanationInput('');
      setDrawerOpen(false);
      setScoreModalOpen(false);
      setClaimModalOpen(false);
      setChatOpen(false);
      setChatMessages([]);
      setUnreadChatCount(0);
      loadRooms();
    });

    s.on('error_msg', (msg: string) => {
      setErrorMsg(msg);
    });

    return () => {
      s.disconnect();
    };
  }, []);

  const modalAcceptedClaim: AcceptedClaimRecord | null = historyModalBoard?.accepted_claim ?? null;
  const rawTricks: CompletedTrickRecord[] = historyModalBoard
    ? historyModalBoard.tricks_history && historyModalBoard.tricks_history.length > 0
      ? historyModalBoard.tricks_history
      : parseTricksFromPbn(historyModalBoard.pbn || '')
    : [];

  const claimCutoffTrickIdx = (() => {
    if (!modalAcceptedClaim) return null;
    if (
      typeof modalAcceptedClaim.acceptedAtTrickNumber === 'number' &&
      modalAcceptedClaim.acceptedAtTrickNumber > 0
    ) {
      return Math.max(0, modalAcceptedClaim.acceptedAtTrickNumber - 1);
    }
    return null;
  })();

  const claimCutoffCardStep = (() => {
    if (!modalAcceptedClaim) return null;
    if (
      typeof modalAcceptedClaim.acceptedAtCardIndex === 'number' &&
      modalAcceptedClaim.acceptedAtCardIndex >= 0
    ) {
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
    if (!room.trim()) return;
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

  const joinSeat = (
    seat: Seat,
    targetRoomId?: string,
    passwordOverride?: string,
    fillBotsOverride?: boolean
  ) => {
    if (!socket) return;
    const chosenRoom = (targetRoomId ?? tableId).trim();
    if (!chosenRoom) return;
    if (chosenRoom !== tableId) {
      setTableId(chosenRoom);
    }
    const trimmedName = playerNameInput.trim() || `Player ${seat}`;
    localStorage.setItem('bridge_player_name', trimmedName);
    const tokenKey = `bridge_token_${chosenRoom}_${seat}`;
    const reconnectToken = localStorage.getItem(tokenKey) || undefined;
    const effectivePassword =
      passwordOverride !== undefined ? passwordOverride.trim() : roomPasswordInput.trim();
    const shouldFillBots =
      fillBotsOverride !== undefined ? fillBotsOverride : fillOpenSeatsWithBots;
    socket.emit('join_table', {
      tableId: chosenRoom,
      seat,
      spectator: false,
      playerName: trimmedName,
      password: effectivePassword || undefined,
      reconnectToken,
      fillBots: shouldFillBots || undefined,
    });
    setDrawerOpen(false);
    setTimeout(() => loadRooms(), 150);
  };

  const joinSpectator = (targetRoomId?: string, passwordOverride?: string) => {
    if (!socket) return;
    const chosenRoom = (targetRoomId ?? tableId).trim();
    if (!chosenRoom) return;
    if (chosenRoom !== tableId) {
      setTableId(chosenRoom);
    }
    const trimmedName = playerNameInput.trim() || 'Spectator';
    const effectivePassword =
      passwordOverride !== undefined ? passwordOverride.trim() : roomPasswordInput.trim();
    socket.emit('join_table', {
      tableId: chosenRoom,
      seat: 'SPECTATOR',
      spectator: true,
      spectatorHandMode,
      playerName: trimmedName,
      password: effectivePassword || undefined,
    });
    setDrawerOpen(false);
    setTimeout(() => loadRooms(), 150);
  };

  const updateSpectatorHandMode = (nextMode: SpectatorHandMode) => {
    setSpectatorHandMode(nextMode);
    if (socket?.connected && tableId.trim()) {
      socket.emit('set_spectator_view', {
        tableId: tableId.trim(),
        mode: nextMode,
      });
    }
  };

  const createFourBotRoom = (targetRoomId?: string, passwordOverride?: string) => {
    if (!socket) return;
    const chosenRoom = (targetRoomId ?? newRoomName).trim();
    if (!chosenRoom) return;
    setTableId(chosenRoom);
    const effectivePassword =
      passwordOverride !== undefined ? passwordOverride.trim() : newRoomPassword.trim();
    const botLabels: Record<Seat, string> = {
      N: 'Bot North',
      E: 'Bot East',
      S: 'Bot South',
      W: 'Bot West',
    };
    socket.emit('join_table', {
      tableId: chosenRoom,
      seat: 'SPECTATOR',
      spectator: true,
      spectatorHandMode,
      playerName: playerNameInput.trim() || 'Spectator',
      password: effectivePassword || undefined,
      fillBots: true,
    });
    SEATS.forEach((s) => {
      socket.emit('add_bot', {
        tableId: chosenRoom,
        seat: s,
        botName: botLabels[s],
      });
    });
    socket.emit('fill_bots', {
      tableId: chosenRoom,
      seats: SEATS,
    });
    setDrawerOpen(false);
    setTimeout(() => loadRooms(), 200);
  };

  const addBotToSeat = (seat: Seat) => {
    const activeRoom = tableId.trim();
    if (!activeRoom || seatNames[seat] || botSeats.includes(seat)) return;
    const botLabel = `Bot ${SEAT_FULL_NAME[seat]}`;
    if (socket?.connected) {
      socket.emit('add_bot', {
        tableId: activeRoom,
        seat,
        botName: botLabel,
      });
    } else {
      setBotSeats((prev) => (prev.includes(seat) ? prev : [...prev, seat]));
      setSeatNames((prev) => ({ ...prev, [seat]: botLabel }));
    }
    setTimeout(() => loadRooms(), 150);
  };

  const fillRemainingSeatsWithBots = () => {
    const activeRoom = tableId.trim();
    if (!activeRoom) return;
    const openSeats = SEATS.filter((s) => !seatNames[s] && !botSeats.includes(s));
    if (openSeats.length === 0) return;
    if (socket?.connected) {
      openSeats.forEach((s) => {
        socket.emit('add_bot', {
          tableId: activeRoom,
          seat: s,
          botName: `Bot ${SEAT_FULL_NAME[s]}`,
        });
      });
      socket.emit('fill_bots', {
        tableId: activeRoom,
        seats: openSeats,
      });
    } else {
      setBotSeats((prev) => Array.from(new Set([...prev, ...openSeats])));
      setSeatNames((prev) => {
        const next = { ...prev };
        openSeats.forEach((s) => {
          if (!next[s]) next[s] = `Bot ${SEAT_FULL_NAME[s]}`;
        });
        return next;
      });
    }
    setTimeout(() => loadRooms(), 150);
  };

  const leaveTable = () => {
    if (mySeat) {
      localStorage.removeItem(`bridge_token_${tableId}_${mySeat}`);
    }
    if (socket?.connected) {
      socket.emit('leave_table', { tableId });
    }
    setGame(null);
    setMySeat(null);
    setIsSpectator(false);
    setSeatNames({});
    setDisplayedTrick([]);
    setSelectedBidLevel(null);
    setExplainingBidIndex(null);
    setExplanationInput('');
    setDrawerOpen(false);
    setScoreModalOpen(false);
    setClaimModalOpen(false);
    setChatOpen(false);
    setChatMessages([]);
    setUnreadChatCount(0);
    setTimeout(() => loadRooms(), 150);
  };

  const removeSeatOccupant = (seat: Seat) => {
    const activeRoom = tableId.trim();
    if (!activeRoom) return;
    if (mySeat === seat) {
      leaveTable();
      return;
    }
    try {
      localStorage.removeItem(`bridge_token_${activeRoom}_${seat}`);
    } catch {
      // Ignore storage errors
    }
    setBotSeats((prev) => prev.filter((s) => s !== seat));
    setSeatNames((prev) => {
      const next = { ...prev };
      delete next[seat];
      return next;
    });
    setAvailableRooms((prev) =>
      prev.map((room) => {
        if (room.id !== activeRoom) return room;
        const nextSeats: Partial<Record<Seat, string>> = { ...(room.seats || {}) };
        delete nextSeats[seat];
        const nextOccupiedCount = SEATS.filter((s) => Boolean(nextSeats[s])).length;
        return {
          ...room,
          seats: nextSeats,
          occupiedCount: nextOccupiedCount,
        };
      })
    );
    if (socket?.connected) {
      socket.emit('kick_seat', { tableId: activeRoom, seat });
      socket.emit('vacate_seat', { tableId: activeRoom, seat });
    }
    setTimeout(() => loadRooms(), 150);
  };

  const sendBid = (call: BidCall) => {
    if (isSpectator || !mySeat) return;
    socket?.emit('make_bid', { tableId, call });
    setSelectedBidLevel(null);
  };

  const alertPartnerBidCall = (bidIndex: number) => {
    if (isSpectator || !mySeat) return;
    socket?.emit('alert_bid', { tableId, bidIndex });
  };

  const askForExplanation = (bidIndex: number) => {
    if (isSpectator || !mySeat) return;
    socket?.emit('request_explanation', { tableId, bidIndex });
  };

  const openPartnerExplainModal = (bidIndex: number, existingExplanation?: string) => {
    if (isSpectator || !mySeat) return;
    setExplainingBidIndex(bidIndex);
    setExplanationInput(existingExplanation || '');
  };

  const submitPartnerExplanation = (alsoAlert: boolean) => {
    if (explainingBidIndex === null || isSpectator || !mySeat) return;
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

  const sendCard = (card: Card, actingSeat?: Seat) => {
    if (isSpectator || !mySeat) return;
    const resolvedSeat = actingSeat || activeHandSeat || mySeat || undefined;
    socket?.emit('play_card', { tableId, card, seat: resolvedSeat });
  };

  const submitClaim = () => {
    if (isSpectator || !mySeat) return;
    socket?.emit('claim_tricks', { tableId, claimedTricks: claimTricksInput });
    setClaimModalOpen(false);
  };

  const respondClaim = (accept: boolean) => {
    if (isSpectator || !mySeat) return;
    socket?.emit('respond_claim', { tableId, accept });
  };

  const sendChatMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSpectator || !mySeat) return;
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
      !isSpectator &&
      !(game.claim && !game.claim.rejectedRevealed) &&
      (game.currentTurn === mySeat ||
        (game.phase === 'PLAYING' &&
          game.currentTurn === game.dummy &&
          game.contract?.declarer === mySeat))
  );

  const activeHandSeat: Seat | null =
    game && mySeat && !isSpectator
      ? game.phase === 'PLAYING' &&
        game.currentTurn === game.dummy &&
        game.contract?.declarer === mySeat
        ? game.dummy
        : mySeat
      : null;

  const isDeclarer = Boolean(game && mySeat && !isSpectator && game.contract?.declarer === mySeat);
  const declarerSide = game?.contract ? sideOf(game.contract.declarer) : null;
  const isDefender = Boolean(
    game && mySeat && !isSpectator && declarerSide && sideOf(mySeat) !== declarerSide
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
      !isSpectator &&
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
  const bottomIsFaceUp = bottomCards.some((c) => c.rank > 0);
  const isClaimRevealed = Boolean(
    game?.claim || game?.acceptedClaim || game?.phase === 'FINISHED'
  );
  const topCards = game?.hands[topSeat] || [];
  const topIsFaceUp = topCards.some((c) => c.rank > 0);
  const leftCards = game?.hands[leftSeat] || [];
  const leftIsFaceUp = leftCards.some((c) => c.rank > 0);
  const rightCards = game?.hands[rightSeat] || [];
  const rightIsFaceUp = rightCards.some((c) => c.rank > 0);

  const isCompactPortrait = viewportWidth <= 768;
  const isWideScreen = viewportWidth >= 1100;
  const bottomCardCount = bottomCards.length;
  const bottomGapPx = isCompactPortrait ? 2 : isWideScreen ? 4 : 1;
  const availHandWidth = Math.max(
    isCompactPortrait
      ? viewportWidth - 24
      : isWideScreen
      ? viewportWidth - 180
      : viewportWidth - 140,
    220
  );
  const wideCardWidthPx =
    bottomCardCount > 0
      ? Math.max(
          56,
          Math.min(
            96,
            Math.floor(
              (availHandWidth - Math.max(0, bottomCardCount - 1) * bottomGapPx) /
                bottomCardCount
            )
          )
        )
      : 72;
  const wideCardHeightPx = Math.round(wideCardWidthPx * 1.45);
  const compactCardWidthPx =
    bottomCardCount > 0 && isCompactPortrait
      ? Math.max(
          20,
          Math.min(
            56,
            Math.floor(
              (availHandWidth - Math.max(0, bottomCardCount - 1) * bottomGapPx) /
                bottomCardCount
            )
          )
        )
      : wideCardWidthPx;
  const compactCardHeightPx = isCompactPortrait
    ? Math.round(compactCardWidthPx * 1.45)
    : wideCardHeightPx;
  const wideRankFontRem = Math.max(
    1.65,
    Math.min(2.4, Number((wideCardWidthPx * 0.025).toFixed(2)))
  );
  const widePipFontRem = Math.max(
    1.45,
    Math.min(2.1, Number((wideCardWidthPx * 0.022).toFixed(2)))
  );
  const bottomStripWidthPx =
    bottomCardCount > 0
      ? bottomCardCount * compactCardWidthPx +
        Math.max(0, bottomCardCount - 1) * bottomGapPx
      : 0;

  const displayNameForSeat = (seat: Seat) => {
    if (seatNames[seat]) return seatNames[seat]!;
    if (botSeats.includes(seat)) return `Bot ${SEAT_FULL_NAME[seat]}`;
    if (mySeat === seat && !isSpectator && playerNameInput.trim()) return playerNameInput.trim();
    return `${SEAT_FULL_NAME[seat]} Seat`;
  };

  const formatSeatLabel = (seat: Seat) => {
    const nm = displayNameForSeat(seat);
    if (mySeat === seat && !isSpectator) return `${nm} (You)`;
    if (game?.dummy === seat) return `${nm} · Dummy`;
    return nm;
  };

  const turnDisplayLabel = game
    ? `${displayNameForSeat(game.currentTurn)} (${game.currentTurn})`
    : '';

  const auctionStatus =
    game && mySeat && !isSpectator
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
    game && mySeat && !isSpectator
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
    const isPartner = Boolean(mySeat && !isSpectator && partnerSeat(entry.seat) === mySeat);
    const isOpponent = Boolean(mySeat && !isSpectator && sideOf(entry.seat) !== sideOf(mySeat));
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
    if (
      modalAcceptedClaim &&
      claimCutoffTrickIdx !== null &&
      tIdx === claimCutoffTrickIdx &&
      claimCutoffCardStep !== null
    ) {
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
    if (
      curTrick &&
      curTrick.cards.length > 0 &&
      revealedCardStep >= curTrick.cards.length &&
      revealedCardStep >= curMaxStep
    ) {
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

  const vulClass = `vul-${(game?.vulnerability || 'NONE').toLowerCase()}`;

  const renderSeatKickButton = (seat: Seat) => {
    if (isSpectator || !seatNames[seat] || mySeat === seat) return null;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          removeSeatOccupant(seat);
        }}
        title={`Remove ${displayNameForSeat(seat)} from ${SEAT_FULL_NAME[seat]} (${seat})`}
        style={{
          marginLeft: 5,
          padding: '0 5px',
          borderRadius: 4,
          border: '1px solid rgba(248, 113, 113, 0.55)',
          background: 'rgba(185, 28, 28, 0.78)',
          color: '#ffffff',
          fontSize: 10.5,
          fontWeight: 700,
          lineHeight: 1.35,
          cursor: 'pointer',
        }}
      >
        ✕
      </button>
    );
  };

  return (
    <div
      className="felt-shell"
      style={{ fontFamily: UI_FONT_FAMILY, boxSizing: 'border-box', overflowX: 'hidden' }}
    >
      {game && (
        <aside className="felt-left-rail">
          <button
            type="button"
            className="rail-menu-btn"
            onClick={() => {
              setDrawerOpen((o) => {
                if (!o) loadRooms();
                return !o;
              });
            }}
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
                  game?.vulnerability === 'BOTH' ||
                  (game?.vulnerability === 'NS' &&
                    ((game?.dealer ?? 'N') === 'N' || (game?.dealer ?? 'N') === 'S')) ||
                  (game?.vulnerability === 'EW' &&
                    ((game?.dealer ?? 'N') === 'E' || (game?.dealer ?? 'N') === 'W'))
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
                        <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>
                          {cumulativeScore.NS}
                        </td>
                        <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>
                          {cumulativeScore.EW}
                        </td>
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
              title="Table Chat"
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
      )}

      <main
        className="felt-stage"
        style={{
          boxSizing: 'border-box',
          overflowX: 'hidden',
          minWidth: 0,
          ...(playWallpaper
            ? {
                backgroundImage: `linear-gradient(rgba(10, 28, 20, 0.28), rgba(10, 28, 20, 0.36)), url("${playWallpaper}")`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
              }
            : wallpaperPresetId
            ? {
                background:
                  WALLPAPER_PRESETS.find((p) => p.id === wallpaperPresetId)?.background ||
                  WALLPAPER_PRESETS[0].background,
              }
            : undefined),
        }}
      >
        {errorMsg && <div className="felt-toast-error">{errorMsg}</div>}

        {!game ? (
          <div
            className="felt-join-overlay"
            style={{
              position: 'fixed',
              inset: 0,
              width: '100%',
              height: '100%',
              padding: 16,
              boxSizing: 'border-box',
              overflowX: 'hidden',
              overflowY: 'auto',
              fontFamily: UI_FONT_FAMILY,
              background:
                'radial-gradient(circle at 50% 0%, #245e45 0%, #194532 60%, #113022 100%)',
              color: '#f8fafc',
              display: 'flex',
              alignItems: 'stretch',
              justifyContent: 'stretch',
            }}
          >
            <div
              className="felt-join-card"
              style={{
                width: '100%',
                minHeight: '100%',
                maxWidth: '100%',
                boxSizing: 'border-box',
                overflowX: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                padding: '18px 20px',
                background: 'rgba(13, 38, 27, 0.72)',
                border: '1px solid rgba(253, 224, 71, 0.28)',
                borderRadius: 12,
                boxShadow: '0 14px 36px rgba(0, 0, 0, 0.28)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  paddingBottom: 12,
                  borderBottom: '1px solid rgba(255, 255, 255, 0.16)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', minWidth: 0 }}>
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: UI_FONT_FAMILY,
                      fontSize: 21,
                      fontWeight: 700,
                      letterSpacing: '-0.015em',
                      color: '#ffffff',
                    }}
                  >
                    Contract Bridge Lobby
                  </h2>
                  <span
                    className="felt-conn-status"
                    style={{
                      margin: 0,
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: connected ? '#86efac' : '#fde68a',
                    }}
                  >
                    {connected ? '● Server Online (:3001)' : '○ Connecting to Server (:3001)...'}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="Tournament mode is currently a work in progress"
                    style={{
                      padding: '7px 13px',
                      borderRadius: 7,
                      fontFamily: UI_FONT_FAMILY,
                      fontSize: 12.5,
                      fontWeight: 600,
                      border: '1px solid rgba(255, 255, 255, 0.16)',
                      background: 'rgba(15, 23, 42, 0.35)',
                      color: 'rgba(248, 250, 252, 0.45)',
                      cursor: 'not-allowed',
                    }}
                  >
                    🏆 Tournament (Work in Progress)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLobbyTab('CASUAL');
                      loadRooms();
                    }}
                    style={{
                      padding: '7px 14px',
                      borderRadius: 7,
                      fontFamily: UI_FONT_FAMILY,
                      fontSize: 12.5,
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                      border: '1px solid #eab308',
                      background: '#facc15',
                      color: '#0f172a',
                      cursor: 'pointer',
                    }}
                  >
                    ♠ Casual Play ({availableRooms.length})
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  background: '#f8f5ec',
                  color: '#1e293b',
                  border: '1px solid #d8d0c1',
                  borderRadius: 10,
                  padding: '10px 14px',
                }}
              >
                <label
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#143828',
                  }}
                >
                  Display Name
                </label>
                <input
                  value={playerNameInput}
                  onChange={(e) => setPlayerNameInput(e.target.value)}
                  placeholder="Enter your name"
                  className="felt-name-input"
                  style={{
                    flex: '1 1 220px',
                    maxWidth: 380,
                    minWidth: 0,
                    padding: '8px 11px',
                    borderRadius: 6,
                    fontFamily: UI_FONT_FAMILY,
                    fontSize: 13.5,
                    border: '1px solid #cbd5e1',
                    background: '#ffffff',
                    color: '#0f172a',
                  }}
                />
              </div>

              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
                  gap: 14,
                  alignContent: 'stretch',
                }}
              >
                {/* Casual Play: Available Rooms */}
                <div
                  style={{
                    minWidth: 0,
                    background: '#f8f5ec',
                    color: '#1e293b',
                    border: '1px solid #d8d0c1',
                    borderRadius: 10,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <strong
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        fontVariantNumeric: 'tabular-nums',
                        color: '#143828',
                      }}
                    >
                      Casual Rooms ({availableRooms.length})
                    </strong>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => {
                          if (socket?.connected) {
                            socket.emit('cleanup_empty_rooms');
                          } else {
                            fetch(`${SERVER_URL}/api/rooms/cleanup`, { method: 'POST' })
                              .then((r) => r.json())
                              .then((d) => {
                                if (Array.isArray(d.rooms)) {
                                  setAvailableRooms(d.rooms);
                                }
                              })
                              .catch(() => {});
                          }
                        }}
                        title="Remove empty rooms"
                        style={{
                          fontFamily: UI_FONT_FAMILY,
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: '1px solid #cbd5e1',
                          background: '#ffffff',
                          color: '#334155',
                          cursor: 'pointer',
                        }}
                      >
                        Clean Empty
                      </button>
                      <button
                        type="button"
                        onClick={loadRooms}
                        style={{
                          fontFamily: UI_FONT_FAMILY,
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: '1px solid #cbd5e1',
                          background: '#ffffff',
                          color: '#334155',
                          cursor: 'pointer',
                        }}
                      >
                        ↻ Refresh
                      </button>
                    </div>
                  </div>

                  {availableRooms.length === 0 ? (
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '20px 14px',
                        borderRadius: 8,
                        border: '1px dashed #b8afa0',
                        background: '#ffffff',
                        textAlign: 'center',
                        fontSize: 13,
                        lineHeight: 1.5,
                        color: '#475569',
                      }}
                    >
                      No active casual rooms right now. Create a room to start a table.
                    </div>
                  ) : (
                    <>
                      <div
                        style={{
                          flex: 1,
                          minHeight: 140,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          overflowY: 'auto',
                        }}
                      >
                        {availableRooms.map((r) => {
                          const isSelected = tableId === r.id;
                          return (
                            <div
                              key={r.id}
                              onClick={() => setTableId(r.id)}
                              style={{
                                padding: '10px 12px',
                                borderRadius: 8,
                                border: isSelected
                                  ? '2px solid #ca8a04'
                                  : '1px solid #d6cfc2',
                                background: isSelected ? '#fef9c3' : '#ffffff',
                                color: '#1e293b',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  gap: 8,
                                  flexWrap: 'wrap',
                                  marginBottom: 6,
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <strong
                                    style={{
                                      fontSize: 14,
                                      color: isSelected ? '#854d0e' : '#0f172a',
                                    }}
                                  >
                                    {r.id}
                                  </strong>
                                  {r.hasPassword && (
                                    <span
                                      title="Password protected"
                                      style={{
                                        fontSize: 11.5,
                                        padding: '1px 6px',
                                        borderRadius: 4,
                                        background: '#fef3c7',
                                        color: '#92400e',
                                        border: '1px solid #f59e0b',
                                      }}
                                    >
                                      🔒 Locked
                                    </span>
                                  )}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span
                                    style={{
                                      fontSize: 12,
                                      fontVariantNumeric: 'tabular-nums',
                                      color: '#475569',
                                    }}
                                  >
                                    Board #{r.boardNumber} · {r.occupiedCount}/4 seated
                                    {typeof r.spectatorCount === 'number'
                                      ? ` · ${r.spectatorCount} watching`
                                      : ''}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setTableId(r.id);
                                      joinSpectator(r.id);
                                    }}
                                    style={{
                                      fontFamily: UI_FONT_FAMILY,
                                      fontSize: 11.5,
                                      fontWeight: 600,
                                      padding: '3px 8px',
                                      borderRadius: 5,
                                      border: '1px solid #94a3b8',
                                      background: '#f8fafc',
                                      color: '#0f172a',
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Spectate
                                  </button>
                                </div>
                              </div>

                              <div
                                style={{
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(4, 1fr)',
                                  gap: 5,
                                }}
                              >
                                {SEATS.map((s) => {
                                  const occupant = r.seats?.[s];
                                  const seatSelected = isSelected && selectedSeat === s;
                                  return (
                                    <button
                                      key={s}
                                      type="button"
                                      disabled={Boolean(occupant)}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setTableId(r.id);
                                        setSelectedSeat(s);
                                      }}
                                      title={
                                        occupant
                                          ? `${SEAT_FULL_NAME[s]} occupied by ${occupant}`
                                          : `Select ${SEAT_FULL_NAME[s]} (${s})`
                                      }
                                      style={{
                                        padding: '4px 6px',
                                        borderRadius: 5,
                                        fontFamily: UI_FONT_FAMILY,
                                        fontSize: 11.5,
                                        border: seatSelected
                                          ? '1.5px solid #ca8a04'
                                          : '1px solid #cbd5e1',
                                        background: occupant
                                          ? '#f1f5f9'
                                          : seatSelected
                                          ? '#fde047'
                                          : '#dcfce7',
                                        color: occupant ? '#64748b' : '#14532d',
                                        cursor: occupant ? 'not-allowed' : 'pointer',
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                      }}
                                    >
                                      <strong>{s}:</strong> {occupant || 'Open'}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div
                        style={{
                          paddingTop: 10,
                          borderTop: '1px solid #d8d0c1',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        {availableRooms.find((r) => r.id === tableId)?.hasPassword && (
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <input
                              type={showRoomPassword ? 'text' : 'password'}
                              value={roomPasswordInput}
                              onChange={(e) => setRoomPasswordInput(e.target.value)}
                              placeholder={`Password for "${tableId}"`}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                padding: '8px 11px',
                                borderRadius: 6,
                                fontFamily: UI_FONT_FAMILY,
                                fontSize: 13,
                                border: '1px solid #cbd5e1',
                                background: '#ffffff',
                                color: '#0f172a',
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setShowRoomPassword((v) => !v)}
                              style={{
                                padding: '7px 11px',
                                borderRadius: 6,
                                fontFamily: UI_FONT_FAMILY,
                                fontSize: 12,
                                fontWeight: 600,
                                border: '1px solid #cbd5e1',
                                background: '#ffffff',
                                color: '#334155',
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {showRoomPassword ? 'Hide' : 'Show'}
                            </button>
                          </div>
                        )}

                        <div className="felt-join-row" style={{ flexWrap: 'wrap', gap: 8 }}>
                          <div style={{ flex: '1 1 120px', minWidth: 0, fontSize: 12.5, color: '#334155' }}>
                            Joining: <strong>{tableId || availableRooms[0]?.id}</strong>
                          </div>
                          <select
                            value={selectedSeat}
                            onChange={(e) => setSelectedSeat(e.target.value as Seat)}
                            style={{
                              minWidth: 0,
                              padding: '8px 10px',
                              borderRadius: 6,
                              fontFamily: UI_FONT_FAMILY,
                              fontSize: 13,
                              border: '1px solid #cbd5e1',
                              background: '#ffffff',
                              color: '#0f172a',
                            }}
                          >
                            {SEATS.map((s) => {
                              const activeRoomObj = availableRooms.find(
                                (r) => r.id === (tableId || availableRooms[0]?.id)
                              );
                              const occupant = activeRoomObj?.seats?.[s];
                              return (
                                <option key={s} value={s}>
                                  Seat {s} ({SEAT_FULL_NAME[s]}){occupant ? ` · ${occupant}` : ' · Open'}
                                </option>
                              );
                            })}
                          </select>
                          <button
                            type="button"
                            onClick={() => {
                              const targetId = tableId || availableRooms[0]?.id;
                              if (!targetId) return;
                              joinSpectator(targetId);
                            }}
                            style={{
                              padding: '8px 12px',
                              borderRadius: 7,
                              fontFamily: UI_FONT_FAMILY,
                              fontSize: 13,
                              fontWeight: 600,
                              border: '1px solid #94a3b8',
                              background: '#ffffff',
                              color: '#0f172a',
                              cursor: 'pointer',
                            }}
                          >
                            Watch as Spectator
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const targetId = tableId || availableRooms[0]?.id;
                              if (!targetId) return;
                              joinSeat(selectedSeat, targetId);
                            }}
                            style={{
                              padding: '8px 14px',
                              borderRadius: 7,
                              fontFamily: UI_FONT_FAMILY,
                              fontSize: 13,
                              fontWeight: 700,
                              border: '1px solid #ca8a04',
                              background: '#facc15',
                              color: '#0f172a',
                              cursor: 'pointer',
                            }}
                          >
                            Join Room
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Casual Play: Create a New Room */}
                <div
                  style={{
                    minWidth: 0,
                    background: '#f8f5ec',
                    color: '#1e293b',
                    border: '1px solid #d8d0c1',
                    borderRadius: 10,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <strong
                      style={{
                        fontSize: 14,
                        fontWeight: 700,
                        color: '#143828',
                      }}
                    >
                      Create a Casual Room
                    </strong>
                    <div style={{ fontSize: 12.5, lineHeight: 1.45, color: '#475569' }}>
                      Start a casual table with optional password protection or 4 AI bots.
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <input
                        value={newRoomName}
                        onChange={(e) => setNewRoomName(e.target.value)}
                        placeholder="New room name (e.g. friday-club)"
                        style={{
                          flex: '1 1 180px',
                          minWidth: 0,
                          padding: '8px 11px',
                          borderRadius: 6,
                          fontFamily: UI_FONT_FAMILY,
                          fontSize: 13,
                          border: '1px solid #cbd5e1',
                          background: '#ffffff',
                          color: '#0f172a',
                        }}
                      />
                      <select
                        value={newRoomSeat}
                        onChange={(e) => setNewRoomSeat(e.target.value as Seat)}
                        style={{
                          flex: '0 1 150px',
                          minWidth: 0,
                          padding: '8px 10px',
                          borderRadius: 6,
                          fontFamily: UI_FONT_FAMILY,
                          fontSize: 13,
                          border: '1px solid #cbd5e1',
                          background: '#ffffff',
                          color: '#0f172a',
                        }}
                      >
                        {SEATS.map((s) => (
                          <option key={s} value={s}>
                            Seat {s} ({SEAT_FULL_NAME[s]})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type={showNewRoomPassword ? 'text' : 'password'}
                        value={newRoomPassword}
                        onChange={(e) => setNewRoomPassword(e.target.value)}
                        placeholder="Optional room password"
                        style={{
                          flex: '1 1 180px',
                          minWidth: 0,
                          padding: '8px 11px',
                          borderRadius: 6,
                          fontFamily: UI_FONT_FAMILY,
                          fontSize: 13,
                          border: '1px solid #cbd5e1',
                          background: '#ffffff',
                          color: '#0f172a',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewRoomPassword((v) => !v)}
                        style={{
                          padding: '8px 12px',
                          borderRadius: 6,
                          fontFamily: UI_FONT_FAMILY,
                          fontSize: 12,
                          fontWeight: 600,
                          border: '1px solid #cbd5e1',
                          background: '#ffffff',
                          color: '#334155',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {showNewRoomPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>

                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: '#1e293b',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={fillOpenSeatsWithBots}
                        onChange={(e) => setFillOpenSeatsWithBots(e.target.checked)}
                        style={{ width: 15, height: 15, cursor: 'pointer' }}
                      />
                      <span>Fill other open seats with AI bots</span>
                    </label>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      disabled={!newRoomName.trim()}
                      style={{
                        flex: '1 1 160px',
                        padding: '9px 14px',
                        borderRadius: 7,
                        fontFamily: UI_FONT_FAMILY,
                        border: newRoomName.trim() ? '1px solid #ca8a04' : '1px solid #cbd5e1',
                        fontWeight: 700,
                        fontSize: 13.5,
                        background: newRoomName.trim() ? '#facc15' : '#e2e8f0',
                        color: newRoomName.trim() ? '#0f172a' : '#64748b',
                        cursor: newRoomName.trim() ? 'pointer' : 'not-allowed',
                      }}
                      onClick={() => {
                        const createdId = newRoomName.trim();
                        if (!createdId) return;
                        setTableId(createdId);
                        setSelectedSeat(newRoomSeat);
                        setRoomPasswordInput(newRoomPassword);
                        joinSeat(newRoomSeat, createdId, newRoomPassword, fillOpenSeatsWithBots);
                      }}
                    >
                      Create &amp; Sit
                    </button>

                    <button
                      type="button"
                      disabled={!newRoomName.trim()}
                      style={{
                        flex: '1 1 160px',
                        padding: '9px 14px',
                        borderRadius: 7,
                        fontFamily: UI_FONT_FAMILY,
                        border: newRoomName.trim() ? '1px solid #0f766e' : '1px solid #cbd5e1',
                        fontWeight: 700,
                        fontSize: 13.5,
                        background: newRoomName.trim() ? '#0f766e' : '#e2e8f0',
                        color: newRoomName.trim() ? '#ffffff' : '#64748b',
                        cursor: newRoomName.trim() ? 'pointer' : 'not-allowed',
                      }}
                      onClick={() => {
                        const createdId = newRoomName.trim();
                        if (!createdId) return;
                        setRoomPasswordInput(newRoomPassword);
                        createFourBotRoom(createdId, newRoomPassword);
                      }}
                    >
                      Create 4-Bot Table (Spectate)
                    </button>
                  </div>
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
                  onPlayCard={(c) => sendCard(c, topSeat)}
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
                {renderSeatKickButton(topSeat)}
              </div>
            </div>

            <div
              className="seat-zone-middle"
              style={
                isCompactPortrait
                  ? {
                      display: 'grid',
                      gridTemplateColumns: 'minmax(44px, 68px) minmax(0, 1fr) minmax(44px, 68px)',
                      alignItems: 'center',
                      gap: 4,
                      width: '100%',
                      minWidth: 0,
                    }
                  : undefined
              }
            >
              <div
                className="seat-zone-side seat-zone-left"
                style={
                  isCompactPortrait
                    ? {
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        minWidth: 0,
                        maxWidth: '100%',
                        overflow: 'hidden',
                      }
                    : undefined
                }
              >
                {leftIsFaceUp || isClaimRevealed ? (
                  <HorizontalSuitHand
                    cards={leftCards}
                    canPlayCard={(c) =>
                      Boolean(game.phase === 'PLAYING' && isMyTurn && activeHandSeat === leftSeat) &&
                      c.rank > 0
                    }
                    onPlayCard={(c) => sendCard(c, leftSeat)}
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
                  style={
                    isCompactPortrait
                      ? {
                          maxWidth: '100%',
                          fontSize: 10.5,
                          padding: '2px 5px',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }
                      : undefined
                  }
                >
                  <span className="felt-seat-tag">{leftSeat}</span>
                  <span className="felt-player-name">{formatSeatLabel(leftSeat)}</span>
                  {renderSeatKickButton(leftSeat)}
                </div>
              </div>

              <div
                className="center-table-area"
                style={
                  isCompactPortrait
                    ? {
                        minWidth: 0,
                        width: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }
                    : undefined
                }
              >
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
                      <div className="claim-waiting-text">
                        {isSpectator
                          ? 'Spectating claim decision...'
                          : 'Waiting for defenders to respond...'}
                      </div>
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

                {game.phase === 'BIDDING' && mySeat && !isSpectator && game.currentTurn === mySeat && (
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
                        {STRAIN_ORDER.filter((st) =>
                          auctionStatus.isStrainLegal(selectedBidLevel, st)
                        ).map((st) => (
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
                        ))}
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

              <div
                className="seat-zone-side seat-zone-right"
                style={
                  isCompactPortrait
                    ? {
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 4,
                        minWidth: 0,
                        maxWidth: '100%',
                        overflow: 'hidden',
                      }
                    : undefined
                }
              >
                {rightIsFaceUp || isClaimRevealed ? (
                  <HorizontalSuitHand
                    cards={rightCards}
                    canPlayCard={(c) =>
                      Boolean(game.phase === 'PLAYING' && isMyTurn && activeHandSeat === rightSeat) &&
                      c.rank > 0
                    }
                    onPlayCard={(c) => sendCard(c, rightSeat)}
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
                  style={
                    isCompactPortrait
                      ? {
                          maxWidth: '100%',
                          fontSize: 10.5,
                          padding: '2px 5px',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }
                      : undefined
                  }
                >
                  <span className="felt-seat-tag">{rightSeat}</span>
                  <span className="felt-player-name">{formatSeatLabel(rightSeat)}</span>
                  {renderSeatKickButton(rightSeat)}
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
              ) : !bottomIsFaceUp && !isClaimRevealed ? (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
                  <FanCardBack orientation="top" count={bottomCards.length || 13} />
                </div>
              ) : (
                <div
                  className="felt-strip-row bottom-hand-strip"
                  style={{
                    width: bottomStripWidthPx > 0 ? `${bottomStripWidthPx}px` : 'fit-content',
                    maxWidth: '100%',
                    minWidth: 0,
                    gap: `${bottomGapPx}px`,
                    display: 'flex',
                    alignItems: 'stretch',
                    justifyContent: 'center',
                    overflow: 'hidden',
                  }}
                >
                  {bottomCards.map((c, idx) => (
                    <StripCardFace
                      key={`${c.suit}-${c.rank}-${idx}`}
                      card={c}
                      disabled={
                        isSpectator ||
                        c.rank === 0 ||
                        !(game.phase === 'PLAYING' && isMyTurn && activeHandSeat === bottomSeat)
                      }
                      onClick={() => sendCard(c, bottomSeat)}
                      highlighted={!isSpectator && game.currentTurn === bottomSeat}
                      rankFontSize={isWideScreen ? `${wideRankFontRem}rem` : undefined}
                      pipFontSize={isWideScreen ? `${widePipFontRem}rem` : undefined}
                      style={
                        isCompactPortrait || isWideScreen
                          ? {
                              flex: `0 0 ${compactCardWidthPx}px`,
                              width: `${compactCardWidthPx}px`,
                              minWidth: `${compactCardWidthPx}px`,
                              maxWidth: `${compactCardWidthPx}px`,
                              height: `${compactCardHeightPx}px`,
                              padding: isWideScreen ? '6px 3px' : '3px 1px',
                              gap: isWideScreen ? '4px' : '2px',
                            }
                          : undefined
                      }
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
                  <span className="felt-seat-tag">{isSpectator ? '👁' : bottomSeat}</span>
                  <span className={`felt-player-icon ${isMyTurn ? 'turn-yellow' : ''}`}>
                    ♛
                  </span>
                  <span className="felt-bottom-user">
                    {mySeat && !isSpectator
                      ? `${displayNameForSeat(bottomSeat)} · ${tableId}`
                      : `Spectator (${
                          spectatorHandMode === 'ALL_HANDS'
                            ? 'All 4 Hands'
                            : 'Dummy & Revealed'
                        }) · ${tableId}`}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}

        {pendingPartnerExplainRequests.length > 0 && game && !isSpectator && (
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

        {explainingBidIndex !== null && game && !isSpectator && game.auction[explainingBidIndex] && (
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

        {claimModalOpen && game && !isSpectator && (
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
                <button
                  type="button"
                  className="claim-cancel-btn"
                  onClick={() => setClaimModalOpen(false)}
                >
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
                                {'\u00A0claims\u00A0'}
                                <strong>{modalAcceptedClaim.claimedDeclarerTricks}</strong>
                                {'\u00A0total\u00A0tricks\u00A0accepted\u00A0('}
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

                {isSpectator && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      marginTop: 8,
                      padding: 8,
                      borderRadius: 8,
                      background: 'rgba(0, 0, 0, 0.25)',
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600 }}>Spectator Hand Visibility</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        type="button"
                        onClick={() => updateSpectatorHandMode('ALL_HANDS')}
                        style={{
                          flex: 1,
                          padding: '5px 8px',
                          borderRadius: 6,
                          border:
                            spectatorHandMode === 'ALL_HANDS'
                              ? '1.5px solid #facc15'
                              : '1px solid rgba(255, 255, 255, 0.2)',
                          background:
                            spectatorHandMode === 'ALL_HANDS'
                              ? 'rgba(250, 204, 21, 0.2)'
                              : 'rgba(255, 255, 255, 0.06)',
                          color: spectatorHandMode === 'ALL_HANDS' ? '#fef08a' : '#f8fafc',
                          fontSize: 11.5,
                          fontWeight: spectatorHandMode === 'ALL_HANDS' ? 700 : 500,
                          cursor: 'pointer',
                        }}
                      >
                        All 4 Hands
                      </button>
                      <button
                        type="button"
                        onClick={() => updateSpectatorHandMode('DUMMY_AND_REVEALED')}
                        style={{
                          flex: 1,
                          padding: '5px 8px',
                          borderRadius: 6,
                          border:
                            spectatorHandMode === 'DUMMY_AND_REVEALED'
                              ? '1.5px solid #facc15'
                              : '1px solid rgba(255, 255, 255, 0.2)',
                          background:
                            spectatorHandMode === 'DUMMY_AND_REVEALED'
                              ? 'rgba(250, 204, 21, 0.2)'
                              : 'rgba(255, 255, 255, 0.06)',
                          color:
                            spectatorHandMode === 'DUMMY_AND_REVEALED' ? '#fef08a' : '#f8fafc',
                          fontSize: 11.5,
                          fontWeight: spectatorHandMode === 'DUMMY_AND_REVEALED' ? 700 : 500,
                          cursor: 'pointer',
                        }}
                      >
                        Dummy &amp; Revealed
                      </button>
                    </div>
                  </div>
                )}

                {game && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      marginTop: 8,
                      padding: 8,
                      borderRadius: 8,
                      background: 'rgba(0, 0, 0, 0.25)',
                      border: '1px solid rgba(255, 255, 255, 0.14)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      <span>Table Seats ({tableId})</span>
                      {SEATS.some((s) => !seatNames[s] && !botSeats.includes(s)) && (
                        <button
                          type="button"
                          onClick={fillRemainingSeatsWithBots}
                          style={{
                            padding: '2px 8px',
                            borderRadius: 5,
                            border: '1px solid rgba(250, 204, 21, 0.55)',
                            background: 'rgba(250, 204, 21, 0.18)',
                            color: '#fef08a',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Fill Open with Bots
                        </button>
                      )}
                    </div>
                    {SEATS.map((s) => {
                      const isBotSeat = botSeats.includes(s);
                      const occupant = seatNames[s] || (isBotSeat ? `Bot ${SEAT_FULL_NAME[s]}` : undefined);
                      const isSelfSeat = !isSpectator && mySeat === s;
                      return (
                        <div
                          key={s}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 8,
                            padding: '5px 8px',
                            borderRadius: 6,
                            background: 'rgba(255, 255, 255, 0.05)',
                            fontSize: 12,
                          }}
                        >
                          <span>
                            <strong>{s}</strong> ({SEAT_FULL_NAME[s]}):{' '}
                            {occupant ? (
                              <>
                                <span>{occupant}</span>
                                {isBotSeat && (
                                  <span
                                    style={{
                                      marginLeft: 5,
                                      padding: '1px 5px',
                                      borderRadius: 4,
                                      fontSize: 10,
                                      fontWeight: 700,
                                      background: 'rgba(56, 189, 248, 0.22)',
                                      color: '#bae6fd',
                                      border: '1px solid rgba(56, 189, 248, 0.45)',
                                    }}
                                  >
                                    BOT
                                  </span>
                                )}
                                {isSelfSeat ? ' (You)' : ''}
                              </>
                            ) : (
                              <span style={{ opacity: 0.65 }}>Open</span>
                            )}
                          </span>
                          {occupant ? (
                            !isSpectator ? (
                              <button
                                type="button"
                                onClick={() => removeSeatOccupant(s)}
                                style={{
                                  padding: '3px 8px',
                                  borderRadius: 5,
                                  border: '1px solid rgba(248, 113, 113, 0.55)',
                                  background: 'rgba(185, 28, 28, 0.78)',
                                  color: '#fff',
                                  fontSize: 11,
                                  fontWeight: 600,
                                  cursor: 'pointer',
                                }}
                              >
                                {isSelfSeat ? 'Leave Seat' : isBotSeat ? 'Remove Bot' : 'Remove'}
                              </button>
                            ) : null
                          ) : (
                            <button
                              type="button"
                              onClick={() => addBotToSeat(s)}
                              style={{
                                padding: '3px 8px',
                                borderRadius: 5,
                                border: '1px solid rgba(250, 204, 21, 0.55)',
                                background: 'rgba(250, 204, 21, 0.16)',
                                color: '#fef08a',
                                fontSize: 11,
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              + Add Bot
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    marginTop: 8,
                    padding: 8,
                    borderRadius: 8,
                    background: 'rgba(0, 0, 0, 0.25)',
                    border: '1px solid rgba(255, 255, 255, 0.14)',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600 }}>Play Area Wallpaper</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {WALLPAPER_PRESETS.map((preset) => {
                      const isActivePreset = !playWallpaper && wallpaperPresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => selectWallpaperPreset(preset.id)}
                          title={`${preset.label} wallpaper`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '4px 8px',
                            borderRadius: 6,
                            border: isActivePreset
                              ? '1.5px solid #facc15'
                              : '1px solid rgba(255, 255, 255, 0.2)',
                            background: isActivePreset
                              ? 'rgba(250, 204, 21, 0.18)'
                              : 'rgba(255, 255, 255, 0.06)',
                            color: isActivePreset ? '#fef08a' : '#f8fafc',
                            fontSize: 11.5,
                            fontWeight: isActivePreset ? 700 : 500,
                            cursor: 'pointer',
                          }}
                        >
                          <span
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: 3,
                              background: preset.swatchBackground,
                              border: '1px solid rgba(255, 255, 255, 0.35)',
                              flexShrink: 0,
                            }}
                          />
                          <span>{preset.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <input
                    ref={wallpaperInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleWallpaperFileChange}
                    style={{ display: 'none' }}
                  />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => wallpaperInputRef.current?.click()}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 6,
                        border: '1px solid rgba(250, 204, 21, 0.65)',
                        background: 'rgba(250, 204, 21, 0.18)',
                        color: '#fef08a',
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Upload Image
                    </button>
                    {playWallpaper && (
                      <button
                        type="button"
                        onClick={clearWallpaper}
                        style={{
                          padding: '5px 10px',
                          borderRadius: 6,
                          border: '1px solid rgba(255, 255, 255, 0.22)',
                          background: 'rgba(255, 255, 255, 0.08)',
                          color: '#f8fafc',
                          fontSize: 11.5,
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Reset Felt
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 12,
                    }}
                  >
                    <span>Available Rooms</span>
                    <button
                      type="button"
                      onClick={loadRooms}
                      style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
                    >
                      Refresh
                    </button>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                      maxHeight: 160,
                      overflowY: 'auto',
                    }}
                  >
                    {availableRooms.length === 0 ? (
                      <div style={{ fontSize: 11.5, opacity: 0.8, padding: '6px 4px' }}>
                        No active rooms. Create a room from the lobby.
                      </div>
                    ) : (
                      availableRooms.map((r) => {
                        const active = tableId === r.id;
                        return (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => setTableId(r.id)}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: '6px 9px',
                              borderRadius: 6,
                              border: active
                                ? '2px solid #facc15'
                                : '1px solid rgba(255,255,255,0.22)',
                              background: active ? 'rgba(250, 204, 21, 0.2)' : 'rgba(0,0,0,0.25)',
                              color: '#fff',
                              fontSize: 12,
                              cursor: 'pointer',
                              textAlign: 'left',
                            }}
                          >
                            <span>
                              {r.id} {r.hasPassword ? '🔒' : ''}
                            </span>
                            <span style={{ opacity: 0.8 }}>{r.occupiedCount}/4</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <input
                    type={showRoomPassword ? 'text' : 'password'}
                    value={roomPasswordInput}
                    onChange={(e) => setRoomPasswordInput(e.target.value)}
                    placeholder="Room password (optional)"
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowRoomPassword((v) => !v)}
                    style={{ fontSize: 11, padding: '4px 8px', cursor: 'pointer' }}
                  >
                    {showRoomPassword ? 'Hide' : 'Show'}
                  </button>
                </div>

                <div className="felt-room-bar" style={{ marginTop: 8 }}>
                  <input
                    value={tableId}
                    onChange={(e) => setTableId(e.target.value)}
                    placeholder="Room ID"
                    style={{ minWidth: 0 }}
                  />
                  <select
                    value={selectedSeat}
                    onChange={(e) => setSelectedSeat(e.target.value as Seat)}
                  >
                    {SEATS.map((s) => {
                      const activeRoomObj = availableRooms.find((r) => r.id === tableId);
                      const occupant = activeRoomObj?.seats?.[s];
                      return (
                        <option key={s} value={s}>
                          {s}
                          {occupant ? ` (${occupant})` : ''}
                        </option>
                      );
                    })}
                  </select>
                  <button
                    type="button"
                    className="rail-claim-btn"
                    onClick={() => joinSeat(selectedSeat)}
                  >
                    Sit
                  </button>
                </div>

                {game && (
                  <div
                    style={{
                      marginTop: 12,
                      paddingTop: 10,
                      borderTop: '1px solid rgba(255, 255, 255, 0.16)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span style={{ fontSize: 12, opacity: 0.85 }}>
                      Room: <strong>{tableId}</strong>
                    </span>
                    <button
                      type="button"
                      onClick={leaveTable}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 6,
                        border: '1px solid rgba(248, 113, 113, 0.5)',
                        background: 'rgba(220, 38, 38, 0.85)',
                        color: '#ffffff',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Leave Table
                    </button>
                  </div>
                )}
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
                      <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>
                        {cumulativeScore.NS}
                      </td>
                      <td className="scorecard-total-yellow" style={{ textAlign: 'center' }}>
                        {cumulativeScore.EW}
                      </td>
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
                  const isMine = !isSpectator && mySeat && m.seat === mySeat;
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
                  mySeat && !isSpectator
                    ? `Message table as ${displayNameForSeat(mySeat)} (${mySeat})...`
                    : 'Spectating (chat disabled for spectators)...'
                }
                disabled={!mySeat || isSpectator}
                maxLength={400}
              />
              <button type="submit" disabled={!mySeat || isSpectator || !chatInput.trim()}>
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