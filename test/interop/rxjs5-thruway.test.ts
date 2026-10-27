// The RxJS 5 suite (rx5-suite.ts) against the reference router's Thruway PHP dialect: RxJS 5 code often talks to a
// Thruway PHP router, so its Rx chains are checked against that router's quirks as well (CANCEL answered with ERROR
// type 49, GOODBYE replies, its auth ABORTs, …).
import { describe } from 'vitest';
import { rx5Suite } from './rx5-suite.js';

describe('RxJS 5.4.3 on Thruway PHP', () => {
  rx5Suite('rxjs543', '5.4.3', 'thruway-php');
});

describe('RxJS 5.5.12 on Thruway PHP', () => {
  rx5Suite('rxjs5', '5.5.12', 'thruway-php');
});
