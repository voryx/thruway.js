<?php
/**
 * Shared bits for the anonymous-WELCOME experiments against stock voryx/thruway 0.6.1.
 * Everything here is either stock Thruway or a user-level AbstractAuthProviderClient subclass (the way a production
 * "extauth" provider would be written). Nothing overrides AuthenticationManager.
 */
require '/app/vendor/autoload.php';

use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;
use Thruway\Authentication\AbstractAuthProviderClient;
use Thruway\Logging\ConsoleLogger;
use Thruway\Logging\Logger;

error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED);

function ts(): string
{
    $t = microtime(true);
    return gmdate('Y-m-d\TH:i:s', (int)$t) . sprintf('.%03dZ', (int)(($t - floor($t)) * 1000));
}

function say(string $who, string $msg): void
{
    fwrite(STDERR, ts() . " [$who] $msg\n");
}

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

Logger::set(new LevelFilterLogger(new ConsoleLogger(), getenv('LOG_LEVEL') ?: 'info'));

/**
 * Custom "extauth" provider, written like any production provider would be: a subclass of the stock
 * AbstractAuthProviderClient. Modes (env PROVIDER_MODE):
 *   challenge   (default) onhello -> CHALLENGE {nonce}; onauthenticate accepts signature "good-signature"
 *   nochallenge onhello -> NOCHALLENGE {authid, authrole, authprovider}  (the stock "welcome without challenge" path)
 *   success     onhello -> SUCCESS {...}  (not a value AuthenticationManager understands at HELLO time)
 *   bare-nochallenge onhello -> NOCHALLENGE {} (no authid at all)
 * PROVIDER_DELAY (seconds): wait that long after the provider's own session is up before registering (models a
 * provider that does async init - DB connection, key fetch - before calling the stock registration sequence).
 */
final class ExtAuthProvider extends AbstractAuthProviderClient
{
    public function __construct(array $authRealms, private string $mode, private float $delay, ?\React\EventLoop\LoopInterface $loop = null)
    {
        parent::__construct($authRealms, $loop);
    }

    public function getMethodName()
    {
        return 'extauth';
    }

    public function onSessionStart($session, $transport)
    {
        say('provider', 'provider session WELCOMEd on realm thruway.auth (session ' . $session->getSessionId() . ')');
        $go = function () use ($session, $transport) {
            say('provider', 'running stock AbstractAuthProviderClient::onSessionStart (register onhello/onauthenticate, call thruway.auth.registermethod for ' . json_encode($this->getAuthRealms()) . ')');
            parent::onSessionStart($session, $transport);
        };
        if ($this->delay > 0) {
            say('provider', "delaying registration by {$this->delay}s");
            $this->getLoop()->addTimer($this->delay, $go);
        } else {
            $go();
        }
    }

    public function processHello(array $args)
    {
        // args[0] is the HelloMessage serialized as its message parts: [1, realm, details]
        $hello   = $args[0] ?? null;
        $details = is_array($hello) ? ($hello[2] ?? null) : (is_object($hello) ? ($hello->details ?? null) : null);
        $authid  = (is_object($details) && isset($details->authid)) ? $details->authid : null;
        say('provider', "onhello invoked (mode {$this->mode}, hello authid " . json_encode($authid) . ')');
        switch ($this->mode) {
            case 'nochallenge':
                return ['NOCHALLENGE', (object)['authid' => $authid ?? 'extuser', 'authrole' => 'user', 'authprovider' => 'ext']];
            case 'bare-nochallenge':
                return ['NOCHALLENGE', new \stdClass()];
            case 'success':
                return ['SUCCESS', (object)['authid' => $authid ?? 'extuser', 'authrole' => 'user']];
            default:
                return ['CHALLENGE', (object)['challenge' => (object)['nonce' => 'n-123'], 'challenge_method' => 'extauth']];
        }
    }

    public function preProcessAuthenticate(array $args)
    {
        $a = $args[0] ?? null;
        $sig = is_object($a) && isset($a->signature) ? $a->signature : null;
        say('provider', 'onauthenticate invoked, signature ' . json_encode($sig));
        if ($sig === 'good-signature') {
            return ['SUCCESS', (object)[
                'authid'       => (is_object($a) && isset($a->authid) && $a->authid) ? $a->authid : 'extuser',
                'authrole'     => 'user',
                'authmethod'   => 'extauth',
                'authprovider' => 'ext',
            ]];
        }
        return ['FAILURE'];
    }
}
