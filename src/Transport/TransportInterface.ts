import {Subject} from 'rxjs/Subject';
import {Observable} from 'rxjs/Observable';
import {Message} from '../Messages/Message';

export interface TransportInterface extends Subject<Message> {
    onOpen: Observable<Event>
    onClose: Observable<CloseEvent>
}
