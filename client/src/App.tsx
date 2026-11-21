import React, { useEffect, useState } from 'react';
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
  | { type: 'CONTRACT'; level: number; strain: Strain; alert?: string };

interface ClaimState {
  claimedBy: Seat;
  claimedDeclarerTricks: number;
  acceptedBy: Seat[];
  rejectedBy: Seat[];
  rejectedRevealed: boolean;
}

interface GameState {
  boardNumber: number;
  dealer: Seat;
  vulnerability: 'NONE' | 'NS' | 'EW' | 'BOTH';
  phase: 'WAITING' | 'BIDDING' | 'PLAYING' | 'FINISHED';
  hands: Partial<Record<Seat, Card[]>>;
  auction: { seat: Seat; call: BidCall }[];
  contract: { level: number; strain: Strain; declarer: Seat; doubled: 0 | 1 | 2 } | null;
  dummy: Seat | null;
  currentTurn: Seat;
  currentTrick: { seat: Seat; card: Card }[];
  tricksHistory: { winner: Seat; cards: { seat: Seat; card: Card }[] }[];
  tricksWon: { NS: number; EW: number };
  score: { NS: number; EW: number } | null;
  claim: ClaimState | null;
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

function formatContractAndResult(board: CompletedBoardRecord): {
  contractLabel: string;
  resultLabel: string;
} {
  if (!board.contract_text || board.contract_text === 'Pass') {
    return { contractLabel: 'Pass', resultLabel: 'Passed Out' };
  }

  const levelMatch = board.contract_text.match(/^([1-7])(C|D|H|S|NT)(XX|X)?$/);
  if (!levelMatch) {
    return { contractLabel: board.contract_text, resultLabel: '-' };
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

  if (diff === 0) {
    return { contractLabel, resultLabel: '=' };
  }
  if (diff > 0) {
    return { contractLabel, resultLabel: `+${diff}` };
  }
  return { contractLabel, resultLabel: `-${Math.abs(diff)}` };
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
      {call.alert ? <small> ({call.alert})</small> : null}
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
    <div className={`hover-pic-card ${red ? 'suit-red' : 'suit-black'}`}>
      <span className="hover-pic-rank">{lbl}</span>
      <span className="hover-pic-pip">{sym}</span>
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
  const [alertText, setAlertText] = useState('');
  const [selectedBidLevel, setSelectedBidLevel] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [history, setHistory] = useState<CompletedBoardRecord[]>([]);
  const [selectedBoardPreview, setSelectedBoardPreview] = useState<number>(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'scoreboard' | 'boards' | 'pbn'>('scoreboard');
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

    s.on('error_msg', (msg: string) => {
      setErrorMsg(msg);
    });

    return () => {
      s.disconnect();
    };
  }, []);

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
    setAlertText('');
    setSelectedBidLevel(null);
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

  const dummyModeForSeat = (seat: Seat): 'declarer-dummy' | 'defender-dummy' => {
    if (game?.dummy === seat && isDefender) {
      return 'defender-dummy';
    }
    return 'declarer-dummy';
  };

  const contractSuitOrder = getSuitOrderForContract(game?.contract?.strain);
  const bottomCards = sortCardsBySuitOrder(game?.hands[bottomSeat] || [], contractSuitOrder);
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

  const auctionCols: Seat[] = ['W', 'N', 'E', 'S'];
  const auctionRows: ({ seat: Seat; call: BidCall } | null)[][] = [];
  if (game) {
    const startIdx = auctionCols.indexOf(game.dealer);
    const flat: ({ seat: Seat; call: BidCall } | null)[] = Array(startIdx).fill(null);
    for (const entry of game.auction) {
      flat.push(entry);
    }
    while (flat.length % 4 !== 0) {
      flat.push(null);
    }
    for (let i = 0; i < flat.length; i += 4) {
      auctionRows.push(flat.slice(i, i + 4));
    }
  }

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
          className={`rail-board-box hover-anchor ${vulClass}`}
          onMouseEnter={() => setHoverBoardPopup(true)}
          onMouseLeave={() => setHoverBoardPopup(false)}
          onClick={() => {
            setHoverBoardPopup((prev) => !prev);
            setHoverContractPopup(false);
            setHoverLastTrickPopup(false);
          }}
        >
          <div className="rail-board-inner">
            <div className="rail-board-num">{game?.boardNumber ?? 1}</div>
            <div className="rail-board-dealer">{game?.dealer ?? 'N'}</div>
          </div>

          {hoverBoardPopup && (
            <div className="rail-hover-popover board-scores-popover">
              <div className="popover-title">Scoreboard</div>
              {history.length === 0 ? (
                <div className="popover-empty">No completed boards yet</div>
              ) : (
                <table className="board-hover-score-table">
                  <thead>
                    <tr>
                      <th>Board</th>
                      <th>Contract</th>
                      <th>Result</th>
                      <th>NS</th>
                      <th>EW</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((b) => {
                      const info = formatContractAndResult(b);
                      return (
                        <tr key={b.id}>
                          <td>#{b.board_number}</td>
                          <td>{info.contractLabel}</td>
                          <td>{info.resultLabel}</td>
                          <td>{b.score_ns}</td>
                          <td>{b.score_ew}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
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
                : displayNameForSeat(game.contract.declarer)
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
                        {cell ? renderColoredBidCall(cell.call) : ''}
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
              setDrawerTab('scoreboard');
              setDrawerOpen(true);
            }}
          >
            Scores
          </button>
        )}
      </aside>

      <main className="felt-stage">
        {game && game.phase !== 'FINISHED' && (
          <div className={`felt-turn-notification ${isMyTurn ? 'my-turn-notify' : ''}`}>
            <span className="turn-notify-dot">●</span>
            <span>
              Turn: <strong>{turnDisplayLabel}</strong>
              {isMyTurn ? ' (Your Turn)' : ''}
            </span>
          </div>
        )}

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
              {topIsFaceUp ? (
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
                {leftIsFaceUp ? (
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
                      {auctionCols.map((col, idx) => (
                        <div
                          key={col}
                          className={`felt-auction-col-title ${idx === 0 ? 'vul-col' : ''}`}
                        >
                          {col}
                        </div>
                      ))}
                    </div>
                    <div className="felt-auction-body">
                      {auctionRows.map((row, rIdx) => (
                        <div key={rIdx} className="felt-auction-row">
                          {row.map((cell, cIdx) => (
                            <div key={cIdx} className="felt-auction-cell">
                              {cell ? renderColoredBidCall(cell.call) : ''}
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
                                  alert: alertText.trim() || undefined,
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
                        <input
                          className="felt-alert-inline"
                          value={alertText}
                          onChange={(e) => setAlertText(e.target.value)}
                          placeholder="Alert note..."
                        />
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
                {rightIsFaceUp ? (
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
              <div className="felt-strip-row bottom-hand-strip">
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

        {drawerOpen && (
          <div className="felt-drawer-backdrop" onClick={() => setDrawerOpen(false)}>
            <div className="felt-drawer-panel" onClick={(e) => e.stopPropagation()}>
              <div className="felt-drawer-head">
                <strong>Table &amp; Duplicate Records</strong>
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

              <div className="felt-drawer-tabs">
                <button
                  type="button"
                  className={drawerTab === 'scoreboard' ? 'active' : ''}
                  onClick={() => setDrawerTab('scoreboard')}
                >
                  Scores
                </button>
                <button
                  type="button"
                  className={drawerTab === 'boards' ? 'active' : ''}
                  onClick={() => setDrawerTab('boards')}
                >
                  Boards (1–16)
                </button>
                <button
                  type="button"
                  className={drawerTab === 'pbn' ? 'active' : ''}
                  onClick={() => setDrawerTab('pbn')}
                >
                  PBN
                </button>
              </div>

              {drawerTab === 'scoreboard' && (
                <div>
                  <div className="felt-totals">
                    <div>
                      <span>NS Total</span>
                      <strong>{cumulativeScore.NS}</strong>
                    </div>
                    <div>
                      <span>EW Total</span>
                      <strong>{cumulativeScore.EW}</strong>
                    </div>
                  </div>
                  {history.length === 0 ? (
                    <p className="felt-muted">No completed boards yet.</p>
                  ) : (
                    history.map((b) => (
                      <div key={b.id} className="felt-hist-row">
                        <span>
                          #{b.board_number} {b.contract_text || 'Pass'} ({b.declarer || '-'})
                        </span>
                        <strong>
                          NS {b.score_ns} / EW {b.score_ew}
                        </strong>
                      </div>
                    ))
                  )}
                </div>
              )}

              {drawerTab === 'boards' && (
                <div>
                  <div className="felt-boards-grid">
                    {Array.from({ length: 16 }, (_, i) => i + 1).map((num) => {
                      const spec = getBoardBadgeSpec(num);
                      return (
                        <button
                          key={num}
                          type="button"
                          className={selectedBoardPreview === num ? 'selected' : ''}
                          onClick={() => setSelectedBoardPreview(num)}
                        >
                          <div>B{num}</div>
                          <small>
                            {spec.dealer} · {spec.vul}
                          </small>
                        </button>
                      );
                    })}
                  </div>
                  <div className="felt-board-meta">
                    Board #{selectedBoardPreview}: Dealer {previewSpec.dealer}, Vul {previewSpec.vul}
                  </div>
                </div>
              )}

              {drawerTab === 'pbn' && (
                <div>
                  {history.length === 0 ? (
                    <p className="felt-muted">No PBN logs yet.</p>
                  ) : (
                    history.map((b) => (
                      <pre key={b.id} className="felt-pbn-pre">
                        {b.pbn}
                      </pre>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
