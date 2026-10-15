#!/usr/bin/env node
import { argv } from 'node:process';
import { dispatch } from './commands/dispatch.js';
dispatch(argv.slice(2))
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map