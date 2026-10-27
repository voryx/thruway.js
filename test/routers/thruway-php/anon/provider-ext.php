<?php
/**
 * The same ExtAuthProvider (stock AbstractAuthProviderClient subclass) run as a SEPARATE PHP process that connects to
 * the router over WebSocket, the way a production auth daemon would (thruway/pawl-transport is not in the image, so
 * MiniWsClientTransportProvider below is a ~80-line stand-in built from the same libs pawl uses: react/socket +
 * ratchet/rfc6455; it calls the stock Client hooks onOpen/onMessage/onClose exactly like PawlTransportProvider).
 * Reconnect behaviour is the stock thruway/client Client::retryConnection (1.5 s initial, x1.5, max 15 retries).
 *
 * env: ROUTER_HOST (127.0.0.1), ROUTER_PORT (8080), PROVIDER_REALMS, PROVIDER_MODE, PROVIDER_DELAY, LOG_LEVEL
 */
require __DIR__ . '/common.php';

use GuzzleHttp\Psr7\Message as Psr7Message;
use GuzzleHttp\Psr7\Uri;
use Ratchet\RFC6455\Handshake\ClientNegotiator;
use Ratchet\RFC6455\Messaging\CloseFrameChecker;
use Ratchet\RFC6455\Messaging\Frame;
use Ratchet\RFC6455\Messaging\MessageBuffer;
use Ratchet\RFC6455\Messaging\MessageInterface;
use React\EventLoop\Loop;
use React\EventLoop\LoopInterface;
use React\Socket\ConnectionInterface;
use React\Socket\Connector;
use Thruway\Message\Message;
use Thruway\Peer\ClientInterface;
use Thruway\Serializer\JsonSerializer;
use Thruway\Transport\AbstractClientTransportProvider;
use Thruway\Transport\AbstractTransport;

final class MiniWsTransport extends AbstractTransport
{
    public function __construct(private ConnectionInterface $conn, private MessageBuffer $buf, LoopInterface $loop)
    {
        $this->loop = $loop;
        $this->setSerializer(new JsonSerializer());
    }

    public function sendMessage(Message $msg)
    {
        $raw = $this->getSerializer()->serialize($msg);
        if (getenv('RAW_FRAMES') === '1') {
            say('provider', '-> ' . $raw);
        }
        $this->buf->sendMessage($raw, true, false);
    }

    public function close()
    {
        $this->conn->close();
    }

    public function getTransportDetails()
    {
        return ['type' => 'miniws', 'transport_address' => (string)$this->conn->getRemoteAddress()];
    }
}

final class MiniWsClientTransportProvider extends AbstractClientTransportProvider
{
    public function __construct(private string $host, private int $port) {}

    public function startTransportProvider(ClientInterface $peer, LoopInterface $loop)
    {
        say('provider', "connecting to ws://{$this->host}:{$this->port}/");
        (new Connector([], $loop))->connect("tcp://{$this->host}:{$this->port}")->then(
            function (ConnectionInterface $conn) use ($peer, $loop) {
                $neg = new ClientNegotiator();
                $req = $neg->generateRequest(new Uri("ws://{$this->host}:{$this->port}/"))
                    ->withHeader('Sec-WebSocket-Protocol', 'wamp.2.json');
                $conn->write(Psr7Message::toString($req));

                $head = '';
                $transport = null;
                $buf = null;
                $onData = function ($data) use (&$head, &$transport, &$buf, $conn, $peer, $loop, $neg, $req, &$onData) {
                    if ($buf !== null) {
                        $buf->onData($data);
                        return;
                    }
                    $head .= $data;
                    $p = strpos($head, "\r\n\r\n");
                    if ($p === false) {
                        return;
                    }
                    $resp = Psr7Message::parseResponse(substr($head, 0, $p + 4));
                    $rest = substr($head, $p + 4);
                    if ($resp->getStatusCode() !== 101) {
                        say('provider', 'upgrade refused: HTTP ' . $resp->getStatusCode());
                        $conn->close();
                        return;
                    }
                    $buf = new MessageBuffer(
                        new CloseFrameChecker(),
                        function (MessageInterface $m) use (&$transport, $peer) {
                            if (getenv('RAW_FRAMES') === '1') {
                                say('provider', '<- ' . $m->getPayload());
                            }
                            $peer->onMessage($transport, $transport->getSerializer()->deserialize($m->getPayload()));
                        },
                        function (Frame $f) use (&$buf, $conn) {
                            if ($f->getOpcode() === Frame::OP_PING) {
                                $buf->sendFrame(new Frame($f->getPayload(), true, Frame::OP_PONG));
                            } elseif ($f->getOpcode() === Frame::OP_CLOSE) {
                                $conn->end();
                            }
                        },
                        false,
                        null, null, null,
                        function ($bytes) use ($conn) { $conn->write($bytes); }
                    );
                    $transport = new MiniWsTransport($conn, $buf, $loop);
                    say('provider', 'websocket open');
                    $peer->onOpen($transport);
                    if ($rest !== '') {
                        $buf->onData($rest);
                    }
                };
                $conn->on('data', $onData);
                $conn->on('close', function () use ($peer) {
                    say('provider', 'connection closed');
                    $peer->onClose('close');
                });
            },
            function (\Throwable $e) use ($peer) {
                say('provider', 'connect failed: ' . $e->getMessage());
                $peer->onClose('unreachable');
            }
        );
    }
}

$realms = array_values(array_filter(explode(',', getenv('PROVIDER_REALMS') ?: 'realm_late')));
$mode   = getenv('PROVIDER_MODE') ?: 'challenge';
$delay  = (float)(getenv('PROVIDER_DELAY') ?: 0);
$loop   = Loop::get();

$provider = new ExtAuthProvider($realms, $mode, $delay, $loop);
$provider->addTransportProvider(new MiniWsClientTransportProvider(getenv('ROUTER_HOST') ?: '127.0.0.1', (int)(getenv('ROUTER_PORT') ?: 8080)));
$provider->on('error', function ($uri) { say('provider', "provider session ABORTed: $uri"); });
$provider->on('close', function ($reason) { say('provider', "provider session closed: $reason"); });
say('provider', 'external provider pid ' . getmypid() . ' realms ' . json_encode($realms) . " mode $mode");
$provider->start(true);
