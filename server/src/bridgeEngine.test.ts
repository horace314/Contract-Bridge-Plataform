import assert from 'node:assert/strict';
import {
  alertPartnerBid,
  applyBid,
  applyPlayCard,
  calculateDuplicateScore,
  createNewBoard,
  explainPartnerBid,
  initiateClaim,
  requestBidExplanation,
  respondToClaim,
  sanitizeStateForSeat,
} from './bridgeEngine';

// 1. All-pass board finishes with 0 score
{
  const g = createNewBoard(1); // Dealer N
  assert.equal(g.phase, 'BIDDING');
  assert.equal(g.currentTurn, 'N');
  for (const seat of ['N', 'E', 'S', 'W'] as const) {
    const res = applyBid(g, seat, { type: 'PASS' });
    assert.equal(res.ok, true);
  }
  assert.equal(g.phase, 'FINISHED');
  assert.deepEqual(g.score, { NS: 0, EW: 0 });
}

// 2. Auction transition to card play & declarer/dummy assignment
{
  const g = createNewBoard(1); // N deals
  assert.equal(applyBid(g, 'N', { type: 'CONTRACT', level: 1, strain: 'NT' }).ok, true);
  assert.equal(applyBid(g, 'E', { type: 'PASS' }).ok, true);
  assert.equal(applyBid(g, 'S', { type: 'CONTRACT', level: 3, strain: 'NT' }).ok, true);
  assert.equal(applyBid(g, 'W', { type: 'PASS' }).ok, true);
  assert.equal(applyBid(g, 'N', { type: 'PASS' }).ok, true);
  assert.equal(applyBid(g, 'E', { type: 'PASS' }).ok, true);

  assert.equal(g.phase, 'PLAYING');
  // First NS bidder to bid NT is N
  assert.equal(g.contract?.declarer, 'N');
  assert.equal(g.dummy, 'S');
  // Opening leader is left of declarer (E)
  assert.equal(g.currentTurn, 'E');
}

// 3. Hand sanitization hides unseen hands until revealed/finished
{
  const g = createNewBoard(1);
  const sView = sanitizeStateForSeat(g, 'S');
  assert.equal(sView.hands.S?.some((c) => c.rank > 0), true);
  assert.equal(sView.hands.N?.every((c) => c.rank === 0), true);
  assert.equal(sView.initialHands, undefined);
}

// 4. Follow-suit enforcement & dummy play by declarer
{
  const g = createNewBoard(2); // E deals
  assert.equal(applyBid(g, 'E', { type: 'CONTRACT', level: 2, strain: 'H' }).ok, true);
  assert.equal(applyBid(g, 'S', { type: 'PASS' }).ok, true);
  assert.equal(applyBid(g, 'W', { type: 'PASS' }).ok, true);
  assert.equal(applyBid(g, 'N', { type: 'PASS' }).ok, true);

  // Declarer E, Dummy W, Opening leader S
  assert.equal(g.currentTurn, 'S');
  const leadCard = g.hands.S[0];
  const playRes = applyPlayCard(g, 'S', leadCard);
  assert.equal(playRes.ok, true);
  assert.equal(g.dummyRevealed, true);
  assert.equal(g.currentTurn, 'W');

  // West (dummy) must be played by declarer E, not W directly
  const dummyCard = g.hands.W[0];
  const wrongActor = applyPlayCard(g, 'W', dummyCard);
  assert.equal(wrongActor.ok, false);

  const followSuit = g.hands.W.find((c) => c.suit === leadCard.suit);
  const hasLeadSuit = g.hands.W.some((c) => c.suit === leadCard.suit);
  if (hasLeadSuit && followSuit) {
    const offSuit = g.hands.W.find((c) => c.suit !== leadCard.suit);
    if (offSuit) {
      const revokeAttempt = applyPlayCard(g, 'E', offSuit);
      assert.equal(revokeAttempt.ok, false);
    }
    assert.equal(applyPlayCard(g, 'E', followSuit).ok, true);
  } else {
    assert.equal(applyPlayCard(g, 'E', dummyCard).ok, true);
  }
}

// 5. Partner alert & explanation workflow
{
  const g = createNewBoard(1);
  assert.equal(applyBid(g, 'N', { type: 'CONTRACT', level: 1, strain: 'NT' }).ok, true);

  // Partner S can alert N's bid; opponent E cannot
  assert.equal(alertPartnerBid(g, 'E', 0).ok, false);
  assert.equal(alertPartnerBid(g, 'S', 0).ok, true);
  assert.equal(g.auction[0].alerted, true);

  // Opponent E requests explanation; partner S explains
  assert.equal(requestBidExplanation(g, 'E', 0).ok, true);
  assert.deepEqual(g.auction[0].explanationRequestedBy, ['E']);
  assert.equal(explainPartnerBid(g, 'S', 0, '15-17 balanced').ok, true);
  assert.equal(g.auction[0].explanation, '15-17 balanced');
  assert.deepEqual(g.auction[0].explanationRequestedBy, []);
}

// 6. Declarer claim & defender acceptance
{
  const g = createNewBoard(1);
  assert.equal(applyBid(g, 'N', { type: 'CONTRACT', level: 3, strain: 'NT' }).ok, true);
  assert.equal(applyBid(g, 'E', { type: 'PASS' }).ok, true);
  assert.equal(applyBid(g, 'S', { type: 'PASS' }).ok, true);
  assert.equal(applyBid(g, 'W', { type: 'PASS' }).ok, true);

  // Non-declarer cannot initiate claim
  assert.equal(initiateClaim(g, 'E', 9).ok, false);
  assert.equal(initiateClaim(g, 'N', 10).ok, true);

  // Declarer cannot accept own claim; defender E can
  assert.equal(respondToClaim(g, 'N', true).ok, false);
  assert.equal(respondToClaim(g, 'E', true).ok, true);

  assert.equal(g.phase, 'FINISHED');
  assert.deepEqual(g.tricksWon, { NS: 10, EW: 3 });
  assert.deepEqual(g.score, calculateDuplicateScore(g.contract!, 10, g.vulnerability));
}

console.log('All bridgeEngine checks passed.');
