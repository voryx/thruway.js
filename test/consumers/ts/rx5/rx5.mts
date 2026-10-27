// RxJS 5.4.3 / 5.5.12 consumer cells (apps that pin RxJS 5; scripts/consumer-matrix.sh): `Observable.from(ours)`
// type-checks through the one `subscribe` signature, RxJS 5 Observables are Inputs, and `rxClient(client,
// Observable.from)` returns RxJS 5 Observables with the prototype-patched operators. Linted through rx5/tsconfig.json,
// where `rxjs` is the repo's rxjs5 alias.
import { Observable } from 'rxjs/Observable';
import 'rxjs/add/observable/from';
import 'rxjs/add/observable/of';
import 'rxjs/add/operator/map';
import { Client, type EventMessage } from 'thruway.js';
import { rxClient } from 'thruway.js/rxjs';

export const seen: unknown[] = [];

export function rx(client: Client): void {
  const events: Observable<EventMessage> = Observable.from(client.topic('com.example.topic'));
  events.map((e) => String(e.args[0])).subscribe((s: string) => seen.push(s));
  const challenged = new Client('ws://127.0.0.1:9/', 'realm1', {
    authmethods: ['ticket'],
    onChallenge: () => Observable.of('secret'),
    autoOpen: false,
  });
  challenged.register('com.example.rx', () => Observable.of(1, 2, 3));
  // RxJS 5's static Observable.from, passed unbound as apps do
  const wamp = rxClient(client, Observable.from);
  wamp
    .call('com.example.add', [1, 2])
    .map((r) => Number(r.args[0]))
    .subscribe((n: number) => seen.push(n));
}
