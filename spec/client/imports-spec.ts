declare const require, __dirname;

import {expect} from 'chai';
import {Client} from '../../src/Client';

const childProcess = require('child_process');
const path = require('path');

// Runs a script in a fresh node process that never loads 'rxjs/Rx', with Client and its Messages directory passed
// in as `clientPath` and `messagesDir`; returns the script's stderr if it exits with a failure, otherwise ''
function runWithoutRx(body: string): string {
    // Referencing Client makes tsc emit the compiled src next to this spec
    expect(Client).to.be.a('function');
    const clientPath = path.resolve(__dirname, '../../src/Client');
    const script = `
        const clientPath = ${JSON.stringify(clientPath)};
        const messagesDir = ${JSON.stringify(path.resolve(__dirname, '../../src/Messages'))};
        const errors = [];
        // A missing operator import shows up as e.g. "TypeError: x.defer is not a function"
        const record = e => errors.push(String(e && e.stack || e));
        const recordUnexpected = e => {
            if (!(e instanceof Error) || e instanceof TypeError || e instanceof ReferenceError) {
                record(e);
            }
        };
        try {
            ${body}
        } catch (e) {
            record(e);
        }
        if (errors.length) {
            process.stderr.write(errors.join('\\n'));
            process.exit(1);
        }
        process.exit(0);
    `;
    try {
        childProcess.execFileSync(process.execPath, ['-e', script], {cwd: path.dirname(clientPath), stdio: 'pipe', timeout: 9000});
    } catch (e) {
        return String(e.stderr || e.message);
    }
    return '';
}

/** @test {client} */
describe('Client imports', () => {

    // The spec helpers load 'rxjs/Rx', which patches every operator onto Observable for the whole mocha process,
    // so a missing 'rxjs/add/operator/...' import in src only shows up in a process that never loads 'rxjs/Rx'.
    it('should subscribe the public methods in a process that does not load rxjs/Rx', function () {
        this.timeout(10000);

        expect(runWithoutRx(`
            const {Client} = require(clientPath);
            const {Subject} = require('rxjs/Subject');
            const client = new Client(new Subject(), 'realm1');
            client.onChallenge(challenge => challenge.map(() => 'signature'));
            client.onOpen.subscribe(null, record);
            client.call('uri').subscribe(null, record);
            client.progressiveCall('uri').subscribe(null, record);
            client.topic('uri').subscribe(null, record);
            client.register('uri', () => 1).subscribe(null, record);
            client.progressiveRegister('uri', () => 1).subscribe(null, record);
            client.publish('uri', 'value');
            client.defaultRetryWhen()(new Subject()).subscribe(null, record);
        `)).to.equal('');
    });
});
