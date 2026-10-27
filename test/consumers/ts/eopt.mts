// exactOptionalPropertyTypes cells (scripts/consumer-matrix.sh): option keys whose value may be `undefined` mean
// "default", so a strict consumer passes possibly-undefined values without casts.
import { Client, type ClientOptions, type RetryOptions, type Timeouts } from 'thruway.js';
import { ticket } from 'thruway.js/auth';

export function make(authid: string | undefined, idle: number | undefined, retries: number | undefined): Client {
  const timeouts: Timeouts = { idle, connect: undefined };
  const retryOptions: RetryOptions = { maxRetries: retries, retryDelay: undefined };
  const options: ClientOptions = {
    authid,
    authmethods: authid === undefined ? undefined : ['ticket'],
    onChallenge: authid === undefined ? undefined : ticket(authid, 'secret').onChallenge,
    timeouts,
    retryOptions,
    logger: undefined,
    WebSocket: undefined,
    autoOpen: false,
  };
  return new Client('ws://127.0.0.1:9/', 'realm1', options);
}
