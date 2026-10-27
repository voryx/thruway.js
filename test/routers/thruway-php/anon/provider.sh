#!/bin/sh
# Start or SIGKILL the external extauth provider of the late-provider configuration (see entry.sh).
#   provider.sh start   (env PROVIDER_DELAY, default 0: seconds between its session start and its registration)
#   provider.sh stop    SIGKILL, like a crashed provider: the router keeps its (now stale) method entry
#   provider.sh status  prints running / stopped
PIDFILE=/tmp/provider.pid
case "$1" in
  start)
    ROUTER_HOST=127.0.0.1 ROUTER_PORT=8080 PROVIDER_REALMS="${PROVIDER_REALMS:-realm_late}" \
      PROVIDER_DELAY="${PROVIDER_DELAY:-0}" LOG_LEVEL="${LOG_LEVEL:-info}" \
      nohup php /app/anon/provider-ext.php >>/tmp/provider.log 2>&1 &
    echo $! >"$PIDFILE"
    echo "provider started (pid $(cat "$PIDFILE"), delay ${PROVIDER_DELAY:-0}s)"
    ;;
  stop)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      kill -9 "$(cat "$PIDFILE")"
      echo "provider killed"
    else
      echo "provider not running"
    fi
    rm -f "$PIDFILE"
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo running; else echo stopped; fi
    ;;
  *)
    echo "usage: provider.sh start|stop|status" >&2
    exit 2
    ;;
esac
