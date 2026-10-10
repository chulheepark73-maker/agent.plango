import { useCallback, useEffect, useState } from 'react';
import apiClient from '../utils/axios';

/**
 * 에이전트 → 중앙 서버 연결 상태
 * @returns {{ checking: boolean, offlineMessage: string, recheck: () => Promise<void> }}
 */
const useCentralStatus = () => {
  const [checking, setChecking] = useState(true);
  const [offlineMessage, setOfflineMessage] = useState('');

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const { data } = await apiClient.get('/auth/central-status');
      setOfflineMessage(
        data?.ok ? '' : `${data?.error || '중앙 서버에 연결할 수 없습니다.'} 연결이 복구된 후 다시 시도해주세요.`
      );
    } catch (error) {
      setOfflineMessage(
        error?.response
          ? '서버 연결 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'
          : '에이전트 서버에 연결할 수 없습니다. 서버 실행 상태를 확인하세요.'
      );
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    recheck();
  }, [recheck]);

  return { checking, offlineMessage, recheck };
};

export default useCentralStatus;
