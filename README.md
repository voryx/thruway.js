# Thruway.js

This project is a WAMP v2 client written in TypeScript that uses RxJS v5 Observables instead of promises and event emitters.
It's designed to work with modern frontend frameworks like Angular v2/4 as well as node.js.

If you don't know what [WAMP](http://wamp-proto.org/) is, you should read up on it.

If you don't know what [RxJS](https://github.com/Reactivex/RxJS) or [ReactiveExtensions](http://reactivex.io/) is, you're missing out...

note: This library is stable, but may not have all of the WAMP features implemented.  Since this project originated as an internal project for [Voryx](http://voryx.net), the features are limited to only the ones that were needed. 

## Installation

```BASH
npm install thruway.js
npm install rxjs
npm install ws // only when using with Node
```

## Usage

```JS
import {Client} from "thruway.js";

const wamp = new Client('ws://localhost:9090', 'realm1');
```

### Call

```JS
wamp.call('add.rpc', [1, 2])
    .map((r: ResultMessage) => r.args[0])
    .subscribe(r => console.log(r));
```

### Register

```JS
wamp.register('add.rpc', (a, b) => a + b).subscribe();
```

### Publish to topic

```JS
wamp.publish('example.topic', 'some value');
wamp.publish('example.topic', Observable.interval(1000)); // you can also publish an observable

```

### Subscribe to topic

```JS
wamp.topic('example.topic').subscribe((v)=>console.log(v));
```

### Angular Example

Create a wamp service

```JS
import {Injectable} from '@angular/core';
import {Client} from 'thruway.js';

@Injectable()
export class WampService extends Client {
    constructor() {
        super('wss://demo.crossbar.io/ws', 'realm1');
    }
}
```

Inject and use the service in your component

```JS
import {Component} from '@angular/core';
import {WampService} from '../wamp.service';
import {Observable} from 'rxjs/Observable';
import {EventMessage} from 'thruway.js/src/Messages/EventMessage';

@Component({
    selector: 'app-counter',
    template: '<span>{{counter | async}}</span>'
})
export class CounterComponent {
    counter: Observable<number> = this.wamp
        .topic('com.myapp.counter')
        .map((r: EventMessage) => r.args[0]);

    constructor(private wamp: WampService) {}
}
```

### Node Example

```JS
const Thruway = require("thruway.js");
const Rx = require("rxjs");

const wamp = new Thruway.Client('wss://demo.crossbar.io/ws', 'realm1');

wamp.publish('com.myapp.counter', Rx.Observable.interval(1000));
```

### PHP Example

Install the RxThruway Client

```BASH
composer require rx/thruway-client

```

```PHP
<?php

use Rx\Observable;
use Rx\Thruway\Client;

require __DIR__ . './vendor/autoload.php';

$wamp = new Client('wss://demo.crossbar.io/ws', 'realm1');

$wamp->publish('com.myapp.counter', Observable::interval(1000));
```
