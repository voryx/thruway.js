import {Observable} from 'rxjs';
import {SubscriptionLog} from "rxjs/internal/testing/SubscriptionLog";
import {observableToBeFn, subscriptionLogsToBeFn} from "rxjs/internal/testing/TestScheduler";
import {HotObservable} from "rxjs/internal/testing/HotObservable";
import {ColdObservable} from "rxjs/internal/testing/ColdObservable";

declare const global: any;

export function hot(marbles: string, values?: any, error?: any): HotObservable<any> {
    if (!global.rxTestScheduler) {
        throw Error('tried to use hot() in async test');
    }
    return global.rxTestScheduler.createHotObservable.apply(global.rxTestScheduler, arguments);
}

export function cold(marbles: string, values?: any, error?: any): ColdObservable<any> {
    if (!global.rxTestScheduler) {
        throw Error('tried to use cold() in async test');
    }
    return global.rxTestScheduler.createColdObservable.apply(global.rxTestScheduler, arguments);
}

export function expectObservable(observable: Observable<any>,
                                 unsubscriptionMarbles: string = null): ({ toBe: observableToBeFn }) {
    if (!global.rxTestScheduler) {
        throw Error('tried to use expectObservable() in async test');
    }
    return global.rxTestScheduler.expectObservable.apply(global.rxTestScheduler, arguments);
}

export function expectSubscriptions(actualSubscriptionLogs: SubscriptionLog[]): ({ toBe: subscriptionLogsToBeFn }) {
    if (!global.rxTestScheduler) {
        throw Error('tried to use expectSubscriptions() in async test');
    }
    return global.rxTestScheduler.expectSubscriptions.apply(global.rxTestScheduler, arguments);
}

export function time(marbles: string): number {
    if (!global.rxTestScheduler) {
        throw Error('tried to use time() in async test');
    }
    return global.rxTestScheduler.createTime.apply(global.rxTestScheduler, arguments);
}
