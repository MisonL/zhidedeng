import { useRef, useState } from 'react';
import type { Target, VoteSummary, VoteValue } from '@zhidedeng/shared';
import { api } from '../api';
import { formatPercent } from '../format';
import { useRequireLogin, useToast } from '../state';
import Icon from './Icon';

function applyVote(votes: VoteSummary, previous: VoteValue, next: VoteValue): VoteSummary {
  const up = votes.up - (previous === 'up' ? 1 : 0) + (next === 'up' ? 1 : 0);
  const down = votes.down - (previous === 'down' ? 1 : 0) + (next === 'down' ? 1 : 0);
  const total = up + down;
  return { up, down, total, upRatio: total ? up / total : 0 };
}

interface VoteButtonsProps extends Target {
  votes: VoteSummary;
  currentUserVote: VoteValue;
}

export default function VoteButtons({ targetType, targetId, votes, currentUserVote }: VoteButtonsProps) {
  const [state, setState] = useState({ votes, currentUserVote });
  const pending = useRef(false);
  const toast = useToast();
  const requireLogin = useRequireLogin();

  async function cast(choice: 'up' | 'down') {
    if (pending.current || !requireLogin()) return;
    pending.current = true;
    const before = state;
    const value = state.currentUserVote === choice ? null : choice;
    setState({ votes: applyVote(state.votes, state.currentUserVote, value), currentUserVote: value });
    try {
      const result = await api.putVote({ targetType, targetId, value });
      setState({ votes: result.votes, currentUserVote: result.currentUserVote });
    } catch (error) {
      setState(before);
      toast((error as Error).message);
    } finally {
      pending.current = false;
    }
  }

  return (
    <div className="vote">
      <div className="vote-group">
        <button
          type="button" className="vote-btn vote-up" aria-pressed={state.currentUserVote === 'up'}
          onClick={() => cast('up')}
        >
          <Icon name="up" size={14} />值 <span className="num">{state.votes.up}</span>
        </button>
        <button
          type="button" className="vote-btn vote-down" aria-pressed={state.currentUserVote === 'down'}
          onClick={() => cast('down')}
        >
          <Icon name="downvote" size={14} />不值 <span className="num">{state.votes.down}</span>
        </button>
      </div>
      {state.votes.total > 0 && (
        <div className="vote-ratio" title={`共 ${state.votes.total} 票`}>
          <span className="vote-bar"><span style={{ width: formatPercent(state.votes.upRatio) }} /></span>
          <span className="num vote-percent">{formatPercent(state.votes.upRatio)}</span>
        </div>
      )}
    </div>
  );
}
