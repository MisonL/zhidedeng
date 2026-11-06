import { useRef, useState } from 'react';
import type { Target } from '@zhidedeng/shared';
import { api } from '../api';
import { useMe, useRequireLogin, useToast } from '../state';
import Icon from './Icon';

interface FavoriteButtonProps extends Target {
  favorited: boolean;
  favoriteCount: number;
}

export default function FavoriteButton({ targetType, targetId, favorited, favoriteCount }: FavoriteButtonProps) {
  const [state, setState] = useState({ favorited, favoriteCount });
  const pending = useRef(false);
  const toast = useToast();
  const { refreshMe } = useMe();
  const requireLogin = useRequireLogin();

  async function toggle() {
    if (pending.current || !requireLogin()) return;
    pending.current = true;
    const before = state;
    const next = !state.favorited;
    setState({ favorited: next, favoriteCount: state.favoriteCount + (next ? 1 : -1) });
    try {
      const result = await api.putFavorite({ targetType, targetId, favorited: next });
      setState({ favorited: result.favorited, favoriteCount: result.favoriteCount });
      refreshMe();
    } catch (error) {
      setState(before);
      toast((error as Error).message);
    } finally {
      pending.current = false;
    }
  }

  return (
    <button type="button" className="meta-btn fav-btn" aria-label="收藏" aria-pressed={state.favorited} onClick={toggle}>
      <Icon name="star" size={15} /><span className="num">{state.favoriteCount}</span>
    </button>
  );
}
