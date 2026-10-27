<?php
/**
 * Thruway (voryx/thruway 0.6.1, PHP) WAMP v2 test router for thruway.js integration / chaos tests.
 *
 * Runs TWO stock Thruway routers on one ReactPHP loop (one process, one container):
 *
 *   "auth"   router (container :8080)
 *       - Thruway AuthenticationManager + WampCraAuthProvider (stock) + TicketAuthProvider (this file)
 *       - realms listed in config "anonymous_realms" (default: realm1) additionally accept anonymous
 *         HELLOs (no authmethods, or authmethods containing "anonymous") - see LenientAuthenticationManager
 *       - realms listed in config "auth_realms" but NOT in "anonymous_realms" (default: realm-auth) are
 *         strict: stock Thruway behaviour, ABORT wamp.error.not_authorized without a matching authmethod
 *       - any other realm name is auto-created and anonymous (stock AuthenticationManager behaviour,
 *         WELCOME.details has NO authid/authrole/authmethod)
 *       - TEST ONLY, on config "admin_realm" (default realm1), through internal clients:
 *           thruway_test.shutdown_session(sessionId)                 InspectionModule's shutdown_session exactly:
 *                                                                    Session::shutdown() (leave + close 1000, no GOODBYE)
 *           thruway_test.goodbye_session(sessionId, reason, message) a router GOODBYE sent through the session's own
 *                                                                    Session::sendMessage, then shutdown() once the
 *                                                                    client answered or after 2 s
 *           thruway_test.count_callees(procedure)                    number of registrations of a procedure (realm1)
 *           thruway_test.sessions()                                  [{session, realm, authid}] of the auth router
 *         and two thruway/client 0.5.8 PHP callees (internal clients, the in-router backend pattern):
 *           thruway_test.php.*         stock Callee role (announces call_canceling, honours INTERRUPT by cancelling
 *                                      the handler's promise)
 *           thruway_test.php_legacy.*  the same Callee, but call_canceling is not announced (older thruway/client
 *                                      releases): Thruway refuses a CANCEL for it with not_supported
 *         Each callee publishes thruway_test.php.done [tag, "completed" | "canceled"] when a slow job ends.
 *
 *   "noauth" router (container :8081)
 *       - completely stock Thruway router (like Examples/SimpleWsRouter.php): no AuthenticationManager,
 *         every realm auto-created, every HELLO welcomed by Thruway\Authentication\AnonymousAuthenticator
 *         (which ECHOES the HELLO details - plus a "transport" object with the HTTP headers - back
 *         inside WELCOME.details)
 *
 * Configuration: /app/config.json (scripts/routers.mjs bind-mounts ./config.json and this file over the image's).
 * Env: THRUWAY_LOG_LEVEL (debug|info|notice|warning|error, default from config, "debug" logs every
 *      raw inbound frame via RatchetTransportProvider "onMessage: (...)").
 */

require __DIR__ . '/vendor/autoload.php';

use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;
use React\EventLoop\Loop;
use React\Promise\Deferred;
use Thruway\Authentication\AbstractAuthProviderClient;
use Thruway\Authentication\AuthenticationDetails;
use Thruway\Authentication\AuthenticationManager;
use Thruway\Authentication\WampCraAuthProvider;
use Thruway\Authentication\WampCraUserDbInterface;
use Thruway\Common\Utils;
use Thruway\WampErrorException;
use Thruway\Logging\ConsoleLogger;
use Thruway\Logging\Logger;
use Thruway\Message\GoodbyeMessage;
use Thruway\Message\HelloMessage;
use Thruway\Message\WelcomeMessage;
use Thruway\Peer\Client;
use Thruway\Peer\Router;
use Thruway\Realm;
use Thruway\Session;
use Thruway\Transport\RatchetTransportProvider;

error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);

$configFile = getenv('THRUWAY_CONFIG') ?: __DIR__ . '/config.json';
$config     = json_decode(file_get_contents($configFile), true, 512, JSON_THROW_ON_ERROR);
$logLevel   = getenv('THRUWAY_LOG_LEVEL') ?: ($config['log_level'] ?? 'notice');

/** Filters Thruway's very chatty ConsoleLogger by PSR-3 level. */
final class LevelFilterLogger extends AbstractLogger
{
    private const ORDER = ['debug' => 0, 'info' => 1, 'notice' => 2, 'warning' => 3, 'error' => 4,
                           'critical' => 5, 'alert' => 6, 'emergency' => 7];

    public function __construct(private LoggerInterface $inner, private string $min) {}

    public function log($level, \Stringable|string $message, array $context = []): void
    {
        if ((self::ORDER[$level] ?? 7) >= (self::ORDER[$this->min] ?? 2)) {
            $this->inner->log($level, $message, $context);
        }
    }
}

Logger::set(new LevelFilterLogger(new ConsoleLogger(), $logLevel));

/** In-memory WAMP-CRA user db (same shape as Thruway's Examples/Authentication/WampCra/UserDb.php). */
final class ConfigUserDb implements WampCraUserDbInterface
{
    private array $users = [];

    public function add(string $authid, string $secret, ?string $salt = null): void
    {
        // Salted users: Thruway stores the PBKDF2-derived key (sha256, 1000 iterations, 32 bytes, base64)
        // and sends {salt, keylen: 32, iterations: 1000} in the CHALLENGE extra.
        $key = $salt !== null ? Utils::getDerivedKey($secret, $salt) : $secret;
        $this->users[$authid] = ['authid' => $authid, 'key' => $key, 'salt' => $salt];
    }

    public function get($authId)
    {
        return $this->users[$authId] ?? false;
    }
}

/**
 * WAMP "ticket" auth. Thruway 0.6.1 has NO built-in ticket provider; this is a minimal one built on the
 * stock AbstractAuthProviderClient plumbing (onhello -> CHALLENGE, onauthenticate -> SUCCESS/FAILURE).
 */
final class TicketAuthProvider extends AbstractAuthProviderClient
{
    public function __construct(array $authRealms, private array $tickets, ?\React\EventLoop\LoopInterface $loop = null)
    {
        parent::__construct($authRealms, $loop);
    }

    public function getMethodName()
    {
        return 'ticket';
    }

    public function processHello(array $args)
    {
        // CHALLENGE extra will be {"challenge": {}, "challenge_method": "ticket"}
        return ['CHALLENGE', (object)['challenge' => new \stdClass(), 'challenge_method' => 'ticket']];
    }

    public function preProcessAuthenticate(array $args)
    {
        $a      = $args[0] ?? null;
        $authid = is_object($a) && isset($a->authid) && is_string($a->authid) ? $a->authid : null;
        $sig    = is_object($a) && isset($a->signature) && is_string($a->signature) ? $a->signature : null;

        if ($authid !== null && $sig !== null && isset($this->tickets[$authid])
            && hash_equals((string)$this->tickets[$authid], $sig)) {
            return ['SUCCESS', (object)['authid' => $authid, 'authrole' => 'user', 'authmethod' => 'ticket', 'authprovider' => 'static']];
        }

        // Same as stock WampCraAuthProvider: ABORT reason "thruway.error.authentication_failure"
        return ['FAILURE'];
    }
}

/**
 * Stock AuthenticationManager aborts (wamp.error.not_authorized) any HELLO on a realm that has an auth
 * provider unless one of HELLO.authmethods matches. For the configured "anonymous realms" this subclass
 * lets HELLOs that ask for nothing (or explicitly for "anonymous") in, exactly the way the stock manager
 * admits sessions on realms without providers (empty WELCOME details + broker/dealer roles).
 */
final class LenientAuthenticationManager extends AuthenticationManager
{
    public function __construct(private array $anonymousRealms)
    {
        parent::__construct();
    }

    public function handleHelloMessage(Realm $realm, Session $session, HelloMessage $msg)
    {
        $realmName = $realm->getRealmName();
        $requested = $msg->getAuthMethods();
        $requested = is_array($requested) ? $requested : [];

        if (in_array($realmName, $this->anonymousRealms, true)) {
            $providerMatches = false;
            foreach ($this->getAuthMethods() as $name => $info) {
                if (in_array($name, $requested, true)
                    && (in_array($realmName, $info['auth_realms'], true) || in_array('*', $info['auth_realms'], true))) {
                    $providerMatches = true;
                    break;
                }
            }

            if (!$providerMatches && (count($requested) === 0 || in_array('anonymous', $requested, true))) {
                $session->setAuthenticationDetails(AuthenticationDetails::createAnonymous());
                $session->sendMessage(new WelcomeMessage($session->getSessionId(), new \stdClass()));
                $session->setAuthenticated(true);

                return;
            }
        }

        parent::handleHelloMessage($realm, $session, $msg);
    }
}

/** TEST ONLY: router-side controls for the integration suite (never in a production router). */
final class TestAdminClient extends Client
{
    public function __construct(string $realm, private Router $router, \React\EventLoop\LoopInterface $loop)
    {
        parent::__construct($realm, $loop);
    }

    public function onSessionStart($session, $transport)
    {
        $session->register('thruway_test.shutdown_session', fn ($args) => $this->shutdown($args));
        $session->register('thruway_test.goodbye_session', fn ($args) => $this->goodbye($args));
        $session->register('thruway_test.count_callees', fn ($args) => $this->countCallees($args));
        $session->register('thruway_test.sessions', fn () => [$this->sessions()]);
    }

    private function find($sessionId): Session
    {
        if (!is_numeric($sessionId)) {
            throw new WampErrorException('wamp.error.invalid_argument');
        }
        foreach ($this->router->getRealmManager()->getRealms() as $realm) {
            foreach ($realm->getSessions() as $session) {
                if ($session->getSessionId() == $sessionId) {
                    return $session;
                }
            }
        }
        throw new WampErrorException('thruway.inspection.404');
    }

    /** InspectionModule::shutdownSession: no GOODBYE, the socket is closed. */
    private function shutdown($args)
    {
        $this->find($args[0] ?? null)->shutdown();

        return [true];
    }

    /** A router-initiated GOODBYE through the victim's own Session, then shutdown(): after its reply or 2 s. */
    private function goodbye($args)
    {
        $session = $this->find($args[0] ?? null);
        $reason  = is_string($args[1] ?? null) ? $args[1] : 'wamp.close.system_shutdown';
        $details = isset($args[2]) && is_string($args[2]) ? (object)['message' => $args[2]] : new \stdClass();
        $session->sendMessage(new GoodbyeMessage($details, $reason));
        // Realm::processGoodbye answers the client's reply (and shuts the session down); this is the fallback.
        $this->getLoop()->addTimer(2, function () use ($session) {
            if ($session->getRealm() !== null) {
                $session->shutdown();
            }
        });

        return [true];
    }

    private function countCallees($args)
    {
        $name = is_string($args[0] ?? null) ? strtolower($args[0]) : '';
        foreach ($this->router->getRealmManager()->getRealms() as $realm) {
            if ($realm->getRealmName() !== $this->getRealm()) {
                continue;
            }
            $procedures = $realm->getDealer()->getProcedures();

            return [isset($procedures[$name]) ? count($procedures[$name]->getRegistrations()) : 0];
        }

        return [0];
    }

    private function sessions(): array
    {
        $out = [];
        foreach ($this->router->getRealmManager()->getRealms() as $realm) {
            foreach ($realm->getSessions() as $session) {
                $details = $session->getAuthenticationDetails();
                $out[]   = [
                    'session' => $session->getSessionId(),
                    'realm'   => $realm->getRealmName(),
                    'authid'  => $details ? $details->getAuthId() : null,
                ];
            }
        }

        return $out;
    }
}

/**
 * TEST ONLY: a thruway/client 0.5.8 callee (an internal client: the in-router backend pattern of Thruway PHP
 * deployments). `$legacy` hides call_canceling from HELLO, like older thruway/client releases.
 */
final class PhpCallee extends Client
{
    public function __construct(string $realm, private string $prefix, private bool $legacy, \React\EventLoop\LoopInterface $loop)
    {
        parent::__construct($realm, $loop);
    }

    public function getRoleInfoObject()
    {
        $roles = parent::getRoleInfoObject();
        if ($this->legacy) {
            $features = clone $roles->callee->features;
            unset($features->call_canceling);
            $roles->callee = (object)['features' => $features];
        }

        return $roles;
    }

    public function onSessionStart($session, $transport)
    {
        $session->register($this->prefix . '.add', fn ($args) => [($args[0] ?? 0) + ($args[1] ?? 0)]);
        $session->register($this->prefix . '.fail', function ($args) {
            throw new WampErrorException('thruway_test.php.failed', [$args[0] ?? 'failed'], (object)['code' => 42]);
        });
        // slow(ms, tag): resolves after ms; INTERRUPT (when announced) cancels it. Either way the end is published.
        $session->register($this->prefix . '.slow', function ($args) use ($session) {
            $ms    = (int)($args[0] ?? 1000);
            $tag   = (string)($args[1] ?? '');
            $timer = null;
            $done  = function (string $how) use ($session, $tag) {
                $session->publish('thruway_test.php.done', [$tag, $how, $this->prefix]);
            };
            $deferred = new Deferred(function ($resolve, $reject) use (&$timer, $done) {
                if ($timer !== null) {
                    $this->getLoop()->cancelTimer($timer);
                }
                $done('canceled');
                $reject(new WampErrorException('wamp.error.canceled'));
            });
            $timer = $this->getLoop()->addTimer($ms / 1000, function () use ($deferred, $done, $tag) {
                $done('completed');
                $deferred->resolve([$tag]);
            });

            return $deferred->promise();
        });
        // progress(n, ms): n progressive results ms apart, then the final [n] (React promise notify()).
        $session->register($this->prefix . '.progress', function ($args) {
            $n        = (int)($args[0] ?? 3);
            $ms       = (int)($args[1] ?? 50);
            $deferred = new Deferred();
            $i        = 0;
            $tick     = function () use (&$tick, &$i, $n, $ms, $deferred) {
                if ($i >= $n) {
                    $deferred->resolve([$n]);

                    return;
                }
                $deferred->notify([$i++]);
                $this->getLoop()->addTimer($ms / 1000, $tick);
            };
            $this->getLoop()->addTimer($ms / 1000, $tick);

            return $deferred->promise();
        });
    }
}

$loop = Loop::get();

// ---------------------------------------------------------------- "auth" router (:8080)
$authListen = $config['auth_router'] ?? ['host' => '0.0.0.0', 'port' => 8080];
$authRouter = new Router($loop);
$authRouter->registerModule(new LenientAuthenticationManager($config['anonymous_realms'] ?? ['realm1']));

$authRealms = $config['auth_realms'] ?? ['realm1', 'realm-auth'];

$userDb = new ConfigUserDb();
foreach (($config['wampcra'] ?? []) as $authid => $u) {
    $userDb->add($authid, $u['secret'], $u['salt'] ?? null);
}
$cra = new WampCraAuthProvider($authRealms, $loop);
$cra->setUserDb($userDb);
$authRouter->addInternalClient($cra);

$authRouter->addInternalClient(new TicketAuthProvider($authRealms, $config['ticket'] ?? [], $loop));

$adminRealm = $config['admin_realm'] ?? 'realm1';
if ($adminRealm !== false) {
    $authRouter->addInternalClient(new TestAdminClient($adminRealm, $authRouter, $loop));
    $authRouter->addInternalClient(new PhpCallee($adminRealm, 'thruway_test.php', false, $loop));
    $authRouter->addInternalClient(new PhpCallee($adminRealm, 'thruway_test.php_legacy', true, $loop));
}

$authTransport = new RatchetTransportProvider($authListen['host'], (int)$authListen['port']);
if (!empty($config['keepalive_seconds'])) {
    $authTransport->enableKeepAlive($loop, (int)$config['keepalive_seconds']);
}
$authRouter->registerModule($authTransport);

// ---------------------------------------------------------------- "noauth" router (:8081)
$plainListen = $config['noauth_router'] ?? ['host' => '0.0.0.0', 'port' => 8081];
$plainRouter = null;
if (($plainListen['enabled'] ?? true) !== false) {
    $plainRouter    = new Router($loop);
    $plainTransport = new RatchetTransportProvider($plainListen['host'], (int)$plainListen['port']);
    if (!empty($config['keepalive_seconds'])) {
        $plainTransport->enableKeepAlive($loop, (int)$config['keepalive_seconds']);
    }
    $plainRouter->registerModule($plainTransport);
}

// Clean shutdown on SIGTERM/SIGINT when ext-pcntl is available (podman stop otherwise SIGKILLs after -t).
if (function_exists('pcntl_signal')) {
    foreach ([SIGTERM, SIGINT] as $sig) {
        $loop->addSignal($sig, function () use ($loop) {
            fwrite(STDERR, "thruway-php: signal received, stopping\n");
            $loop->stop();
        });
    }
}

fwrite(STDERR, sprintf(
    "thruway-php: PHP %s, voryx/thruway %s, thruway/client %s; auth router ws://%s:%d/ (auth realms: %s; anonymous realms: %s; test admin realm: %s), noauth router %s\n",
    PHP_VERSION,
    \Composer\InstalledVersions::getPrettyVersion('voryx/thruway'),
    \Composer\InstalledVersions::getPrettyVersion('thruway/client'),
    $authListen['host'], $authListen['port'],
    implode(',', $authRealms),
    implode(',', $config['anonymous_realms'] ?? ['realm1']),
    $adminRealm === false ? 'disabled' : $adminRealm,
    $plainRouter ? sprintf('ws://%s:%d/', $plainListen['host'], $plainListen['port']) : 'disabled'
));

if ($plainRouter) {
    $plainRouter->start(false);
}
$authRouter->start(true);
