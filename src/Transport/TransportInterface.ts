import {Subject} from 'rxjs/Subject';
import {Observable} from 'rxjs/Observable';
import {IMessage} from '../Messages/Message';

export interface TransportInterface extends Subject<IMessage> {
    onOpen: Observable<Event>
    onClose: Observable<CloseEvent>
}
