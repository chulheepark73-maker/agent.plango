/**
 * 시세 WebSocket URL / 헬퍼 (Watchlist · Dashboard · Holdings 공용)
 * 경로: /ws/watchlist-prices
 */

function getApiHttpBase() {
  if (process.env.REACT_APP_API_URL) {
    return process.env.REACT_APP_API_URL.replace(/\/$/, '');
  }
  if (process.env.NODE_ENV === 'production') {
    return '/api';
  }
  if (typeof window !== 'undefined') {
    const { protocol, hostname } = window.location;
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return `${protocol}//${hostname}:3001/api`;
    }
  }
  return 'http://localhost:3001/api';
}

/**
 * @param {string} token JWT
 * @returns {string} ws(s) URL
 */
export function getWatchlistPricesWsUrl(token) {
  const apiBase = getApiHttpBase();
  let wsBase;

  if (apiBase.startsWith('/')) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${proto}//${window.location.host}`;
  } else {
    const u = new URL(apiBase);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = `${proto}//${u.host}`;
  }

  const q = encodeURIComponent(token || '');
  return `${wsBase}/ws/watchlist-prices?token=${q}`;
}

/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {(msg: object) => void} opts.onMessage
 * @param {(ev?: Event) => void} [opts.onOpen]
 * @param {(ev?: CloseEvent) => void} [opts.onClose]
 * @param {(err: Event) => void} [opts.onError]
 * @returns {{ send: (obj: object) => void, close: () => void, getSocket: () => WebSocket|null }}
 */
export function connectWatchlistPricesWs({ token, onMessage, onOpen, onClose, onError }) {
  let socket = null;
  let closedByUser = false;
  let reconnectTimer = null;
  let delay = 1000;

  const connect = () => {
    if (closedByUser) return;
    const url = getWatchlistPricesWsUrl(token);
    socket = new WebSocket(url);

    socket.onopen = (ev) => {
      delay = 1000;
      if (onOpen) onOpen(ev);
    };

    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (onMessage) onMessage(msg);
      } catch {
        /* ignore */
      }
    };

    socket.onerror = (ev) => {
      if (onError) onError(ev);
    };

    socket.onclose = (ev) => {
      if (onClose) onClose(ev);
      socket = null;
      // 4403: 계정 정지, 4409: 서버 미등록 — 재연결해도 거부된다
      if (closedByUser || ev?.code === 4403 || ev?.code === 4409) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
        delay = Math.min(delay * 2, 15000);
      }, delay);
    };
  };

  connect();

  return {
    send(obj) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(obj));
      }
    },
    close() {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
    },
    getSocket: () => socket,
  };
}

/** 별칭 — Dashboard / Holdings 에서 사용 */
export const connectPricesWs = connectWatchlistPricesWs;
