// RxJS 7 and RxJS 6 consumer cells (APIs common to both; scripts/consumer-matrix.sh): our Observables go into the app's
// own `from`, RxJS Observables come back as Inputs (onChallenge, handler results), and `thruway.js/rxjs` types
// `rxClient(client, from)` with the consumer's own RxJS (its .d.ts imports `rxjs`). The cells check the thruway.js/rxjs
// types only.
import { from, of, type Observable as RxObservable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Client, type EventMessage, type ResultMessage } from 'thruway.js';
import { rxClient, type RxClient } from 'thruway.js/rxjs';

export const seen: unknown[] = [];

export function rx(client: Client): RxClient {
  const events: RxObservable<EventMessage<[string]>> = from(client.topic<[string]>('com.example.topic'));
  events.pipe(map((e) => e.args[0])).subscribe((s: string) => seen.push(s));
  const challenged = new Client('ws://127.0.0.1:9/', 'realm1', {
    authmethods: ['ticket'],
    onChallenge: () => of('secret'),
    autoOpen: false,
  });
  challenged.register('com.example.rx', () => of(1, 2, 3));
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- `from` as a value: only its scheduler overload is deprecated
  const wamp = rxClient(client, from);
  const result: RxObservable<ResultMessage<[number]>> = wamp.call<[number]>('com.example.add', [1, 2]);
  result.subscribe((r) => seen.push(r.args[0]));
  wamp.status.pipe(map((s) => s.state)).subscribe();
  // @ts-expect-error rxClient needs the app's from
  seen.push(rxClient(client));
  return wamp;
}
