import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';
import { createChatDelivery } from '@/shared/chatDelivery';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * Where the chat socket stands. `connecting` covers a handshake the provider
 * started on purpose (after sign-in, or with a refreshed token) and the time
 * signed out; `disconnected` a socket that closed on its own (it dropped, or an
 * attempt failed) until a reconnect opens again.
 */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void | Promise<void>;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
  /**
   * Lets the UI tell a lost connection (`disconnected`, reconnecting every few
   * seconds) apart from the first handshake (`connecting`), so it can show the
   * former without flashing on every page load. A socket the provider replaces
   * on purpose, such as on a token refresh, reports `connecting` until the new
   * one opens, never `disconnected`.
   */
  connectionStatus: ConnectionStatus;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession();
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Drives `isConnected` and the workspace header's "Reconnecting" indicator.
  // Three values rather than a boolean: a first handshake still in flight must
  // not read as a lost connection, or every page load would flash the indicator.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const { isLoading: isAuthLoading, token, user } = useAuth();
  // Retains acknowledgement waiters through reconnects without re-rendering on each frame.
  const ownerRef = useRef('');
  ownerRef.current = String(user?.id ?? user?.username ?? 'platform');
  const deliveryRef = useRef<ReturnType<typeof createChatDelivery> | null>(null);
  if (!deliveryRef.current) deliveryRef.current = createChatDelivery(() => wsRef.current, () => ownerRef.current);

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Depend on the account identity, not a freshly allocated auth user object.
  const userKey = user ? String(user.id ?? user.username) : null;
  useEffect(() => {
    if (!IS_PLATFORM && (isAuthLoading || !userKey)) return;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lastReceivedAt = Date.now();
    let startedAt = Date.now();
    let awaitingPong = false;

    const clearSocketTimers = () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      deadline = undefined;
      heartbeat = undefined;
      awaitingPong = false;
    };
    const retireSocket = () => {
      clearSocketTimers();
      const previous = wsRef.current;
      wsRef.current = null;
      if (previous) {
        // Do not wait for a close handshake on a broken mobile connection.
        // Late events from this socket must not affect its replacement.
        previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
        try { previous.close(); } catch { /* Already closed. */ }
      }
    };
    const retryConnection = () => {
      if (stopped) return;
      retireSocket();
      setConnectionStatus('disconnected');
      clearTimeout(retry);
      retry = setTimeout(connect, 3000);
    };
    const probe = () => {
      const socket = wsRef.current;
      if (socket && socket.readyState >= WebSocket.CLOSING) {
        retryConnection();
        return;
      }
      if (!socket || socket.readyState !== WebSocket.OPEN || awaitingPong) return;
      awaitingPong = true;
      deadline = setTimeout(retryConnection, 10_000);
      try { socket.send(JSON.stringify({ type: 'chat.ping' })); }
      catch { retryConnection(); }
    };
    function connect() {
      if (stopped) return;
      clearTimeout(retry);
      retireSocket();
      const wsUrl = buildWebSocketUrl(token);
      if (!wsUrl) return;
      startedAt = Date.now();
      try {
        const websocket = new WebSocket(wsUrl);
        wsRef.current = websocket;
        // Browsers can remain CONNECTING indefinitely after a network switch.
        deadline = setTimeout(retryConnection, 10_000);
        websocket.onopen = () => {
          if (wsRef.current !== websocket || stopped) return;
          clearSocketTimers();
          lastReceivedAt = Date.now();
          setConnectionStatus('connected');
          if (hasConnectedRef.current) {
            dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
          }
          hasConnectedRef.current = true;
          deliveryRef.current?.reconnect();
          heartbeat = setInterval(probe, 15_000);
        };
        websocket.onmessage = (event) => {
          if (wsRef.current !== websocket || stopped) return;
          try {
            const data = JSON.parse(event.data) as ServerEvent;
            lastReceivedAt = Date.now();
            // Any server frame proves the receiving path is alive.
            if (awaitingPong) {
              clearTimeout(deadline);
              deadline = undefined;
              awaitingPong = false;
            }
            if (data.kind === 'chat_pong') return;
            if (deliveryRef.current?.receive(data)) {
              if (data.status === 'accepted' && data.replayed) {
                // Reconcile after the composer's promise clears its draft/echo.
                setTimeout(() => {
                  if (wsRef.current === websocket) dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
                }, 0);
              }
              return;
            }
            dispatch(data);
          } catch (error) {
            console.error('Error parsing WebSocket message:', error);
          }
        };
        websocket.onclose = websocket.onerror = () => {
          if (wsRef.current === websocket) retryConnection();
        };
      } catch (error) {
        console.error('Error creating WebSocket connection:', error);
        retryConnection();
      }
    }
    const recover = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      const socket = wsRef.current;
      if (!socket || socket.readyState >= WebSocket.CLOSING
        || (socket.readyState === WebSocket.CONNECTING && Date.now() - startedAt >= 10_000)
        || (socket.readyState === WebSocket.OPEN && Date.now() - lastReceivedAt >= 30_000)) {
        setConnectionStatus('disconnected');
        connect();
      } else {
        probe();
      }
    };
    connect();
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    window.addEventListener('pageshow', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      stopped = true;
      clearTimeout(retry);
      retireSocket();
      deliveryRef.current?.dispose();
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
      window.removeEventListener('pageshow', recover);
      document.removeEventListener('visibilitychange', recover);
      setConnectionStatus('connecting');
    };
  }, [dispatch, isAuthLoading, token, userKey]);

  const sendMessage = useCallback((message: unknown) => {
    const frame = message as Record<string, unknown>;
    if (frame?.type === 'chat.send' || frame?.type === 'chat.edit-send') {
      return deliveryRef.current!.send(frame);
    }
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected: connectionStatus === 'connected',
    connectionStatus,
  }), [sendMessage, subscribe, connectionStatus]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
