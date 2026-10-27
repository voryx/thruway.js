# Real-router transcripts

Recorded by the integration suite: `RECORD_TRANSCRIPTS=1 npm run test:integration`
rewrites `<router>--<test file>.jsonl` from the frames the clients of that file saw (the default run: Thruway PHP's
`thruway-php--*` and `thruway-php-anon--*`; `ROUTERS=all` also the other routers' files, last recorded at 7acdc85).
Flat, with the router in the file name: `test/fuzz/transcripts.fuzz.test.ts` lists this directory and takes the
dialect from the name.

- One JSON object per line: a `FrameRecord` (`src/testing/index.ts`) —
  `{"connection": n, "direction": "in" | "out", "frame": [...] | "raw text", "at": ms}`; `in` = client → router,
  `at` = ms since the client was created. Connection numbers are unique within a file (clients are offset).
- At most 120 lines per file; frames over 2 KiB are left out. Unique URIs, session ids and random request ids are as
  recorded (they differ per run).
- Consumers: `test/fuzz/transcripts.fuzz.test.ts` mutates them; nothing else depends on their content.
