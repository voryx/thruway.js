import {IMessage} from '../Messages/Message';
import {Subject,Observable} from "rxjs";

export interface TransportInterface extends Subject<IMessage> {
    onOpen: Observable<Event>
    onClose: Observable<CloseEvent>
}
