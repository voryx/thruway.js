#!/bin/sh
# Thruway PHP "late provider" configuration: a stock router with an AuthenticationManager and NO provider of its own,
# plus an EXTERNAL provider process (provider-ext.php, method "extauth") that is the only provider of PROVIDER_REALMS.
# The provider joins over WebSocket and registers PROVIDER_DELAY seconds after its session started, so the realm answers
# HELLOs with an anonymous WELCOME until then. Tests kill and restart the provider with `provider.sh stop|start` (podman
# exec): a killed provider leaves a stale method entry, so HELLOs get ABORT thruway.error.unknown until it is back.
set -e
export PROVIDER_REALMS="${PROVIDER_REALMS:-realm_late}"
PROVIDER_DELAY="${PROVIDER_DELAY:-10}" sh /app/anon/provider.sh start
AUTH_MANAGER=1 INTERNAL_PROVIDER=0 PORT=8080 exec php /app/anon/router-anon.php
