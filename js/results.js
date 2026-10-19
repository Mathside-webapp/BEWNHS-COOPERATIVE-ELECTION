/** Pure count/ranking logic, also implemented server-side in Edge Function. */
export function allocateSeats(candidates, counts, seats, excluded = [], tieBreaks = []) {
  const excludedSet = new Set(excluded);
  const rows = candidates.map(c => ({ ...c, votes: Number(counts[c.id] || 0), status: excludedSet.has(c.id) ? 'board_winner' : 'not_elected' }))
    .sort((a,b) => b.votes-a.votes || a.name.localeCompare(b.name));
  const eligible = rows.filter(r => !excludedSet.has(r.id) && r.votes > 0);
  const winnerIds = [];
  const pending = [];
  let remaining = seats;
  for (let i=0; i<eligible.length && remaining>0;) {
    const voteCount = eligible[i].votes;
    const group = eligible.filter(r => r.votes === voteCount);
    i += group.length;
    if (group.length <= remaining) {
      group.forEach(r=> winnerIds.push(r.id));
      remaining -= group.length;
    } else {
      const resolution = tieBreaks.find(x => x.vote_count === voteCount);
      const selected = resolution?.winner_ids || [];
      if (selected.length === remaining && selected.every(id => group.some(r=>r.id === id)) && new Set(selected).size === selected.length) {
        winnerIds.push(...selected);
        remaining = 0;
      } else {
        pending.push({ votes: voteCount, available: remaining, candidates: group.map(r=>({id:r.id,name:r.name})) });
        break;
      }
    }
  }
  const winnerSet = new Set(winnerIds);
  rows.forEach(r => {if(winnerSet.has(r.id)) r.status='elected'; else if(pending.some(g=>g.candidates.some(c=>c.id===r.id))) r.status='tie_pending';});
  return {rows, winner_ids: winnerIds, pending, shortage: !pending.length && winnerIds.length < seats, seats};
}
export function calculateResults(boardCandidates, auditCandidates, votes, tieBreaks=[]) {
  const boardCounts={}, auditCounts={};
  for (const v of votes) {
    for(const id of v.board || []) boardCounts[id] = (boardCounts[id] || 0) + 1;
    for(const id of v.audit || []) auditCounts[id] = (auditCounts[id] || 0) + 1;
  }
  const board=allocateSeats(boardCandidates, boardCounts,5,[],tieBreaks.filter(r=>r.committee==='board'));
  const audit=board.pending.length?null:allocateSeats(auditCandidates,auditCounts,3,board.winner_ids,tieBreaks.filter(r=>r.committee==='audit'));
  return {board,audit,board_pending:board.pending.length>0};
}
