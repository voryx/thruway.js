<?php
/**
 * Configurable STOCK voryx/thruway 0.6.1 router for the anonymous-WELCOME experiments.
 *
 * env:
 *   PORT              listen port inside the container (default 8080)
 *   AUTH_MANAGER      1 = registerModule(new \Thruway\Authentication\AuthenticationManager()) (stock), 0 = none
 *   INTERNAL_PROVIDER 1 = $router->addInternalClient(new ExtAuthProvider(...)) like router.php / Thruway examples
 *   PROVIDER_REALMS   comma list of auth realms for the provider (default realm_late)
 *   PROVIDER_MODE     challenge|nochallenge|bare-nochallenge|success (see common.php)
 *   PROVIDER_DELAY    seconds the internal provider waits before running the stock registration sequence
 *   LOG_LEVEL         Thruway logger level (default info; debug logs every inbound frame)
 *
 * Observation only (no behaviour change): a 50 ms timer prints AuthenticationManager's registered auth methods and
 * ready flag whenever they change, so the logs show exactly what the manager knew when each HELLO arrived.
 */
require __DIR__ . '/common.php';

use React\EventLoop\Loop;
use Thruway\Authentication\AuthenticationManager;
use Thruway\Peer\Router;
use Thruway\Transport\RatchetTransportProvider;

$port     = (int)(getenv('PORT') ?: 8080);
$withAm   = getenv('AUTH_MANAGER') === '1';
$withProv = getenv('INTERNAL_PROVIDER') === '1';
$realms   = array_values(array_filter(explode(',', getenv('PROVIDER_REALMS') ?: 'realm_late')));
$mode     = getenv('PROVIDER_MODE') ?: 'challenge';
$delay    = (float)(getenv('PROVIDER_DELAY') ?: 0);

$loop   = Loop::get();
$router = new Router($loop);

$am = null;
if ($withAm) {
    $am = new AuthenticationManager();
    $router->registerModule($am);
}
if ($withProv) {
    $router->addInternalClient(new ExtAuthProvider($realms, $mode, $delay, $loop));
}
$router->registerModule(new RatchetTransportProvider('0.0.0.0', $port));

if ($am) {
    $last = null;
    $loop->addPeriodicTimer(0.05, function () use ($am, &$last) {
        $view = ['ready' => $am->getReady(), 'methods' => []];
        foreach ($am->getAuthMethods() as $name => $info) {
            $view['methods'][$name] = ['auth_realms' => $info['auth_realms'], 'session_id' => $info['session_id']];
        }
        $j = json_encode($view);
        if ($j !== $last) {
            say('router', "AuthenticationManager state: $j");
            $last = $j;
        }
    });
}

say('router', sprintf('voryx/thruway %s, port %d, AuthenticationManager=%s, internal provider=%s realms=%s mode=%s delay=%s',
    \Composer\InstalledVersions::getPrettyVersion('voryx/thruway'), $port, $withAm ? 'yes' : 'no',
    $withProv ? 'yes' : 'no', json_encode($realms), $mode, $delay));

$router->start(true);
